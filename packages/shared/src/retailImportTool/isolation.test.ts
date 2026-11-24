import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Runtime imports and re-exports (`from '…'`) and side-effect imports. `import type` is erased, so it isn't one. */
function specifiers(source: string): string[] {
  const pattern = /^\s*(?:import|export)\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2]);
}

function moduleGraph(entry: string): { files: Map<string, string>; external: Set<string> } {
  const files = new Map<string, string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    const source = readFileSync(file, 'utf8');
    files.set(file, source);
    for (const specifier of specifiers(source)) {
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      else external.add(specifier);
    }
  };
  visit(entry);
  return { files, external };
}

describe('retail import tool isolation', () => {
  it('exports the payload contract on its own subpath, whose module graph holds no converter and is pure', () => {
    // The importer (apps/api services/retail) reads the payload through this subpath only, never the tool's index, so no
    // API module reaches the converter (costco.ts) or the capture fixtures (Costco plan v5, PR 2).
    const manifest = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
    assert.deepEqual(manifest.exports['./retail-import-payload'], {
      types: './dist/retailImportTool/payload.d.ts',
      import: './dist/retailImportTool/payload.js',
    });
    const { files, external } = moduleGraph(join(here, 'payload.ts'));
    const names = [...files.keys()].map((file) => relative(resolve(here, '..'), file).split(sep).join('/'));
    assert.ok(names.includes('retailImportTool/payload.ts'));
    for (const name of names) {
      assert.ok(name !== 'retailImportTool/costco.ts' && name !== 'retailImportTool/index.ts', name);
      assert.ok(!name.includes('__fixtures__'), name);
    }
    assert.deepEqual([...external], []);
  });

  it('is pure: no platform, network, dynamic code, environment or clock anywhere in its module graph', () => {
    const { files, external } = moduleGraph(join(here, 'index.ts'));
    // Relative to src/, with '/' on every platform (Windows paths use '\').
    const names = [...files.keys()].map((file) => relative(resolve(here, '..'), file).split(sep).join('/'));
    for (const expected of ['retailImportTool/costco.ts', 'retailImportTool/payload.ts', 'retailImportTool/metalTitleRule.ts', 'cardImport.ts', 'cardNumbers.ts', 'cardDedupe.ts']) {
      assert.ok(names.includes(expected), expected);
    }
    // The CLI (apps/api) reads and writes the files; the library touches nothing.
    assert.deepEqual([...external], []);
    for (const [file, source] of files) {
      const apis = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\beval\s*\(|\bnew\s+Function\b|\bprocess\.binding\b|\bimport\s*\(|\brequire\s*\(|\bglobalThis\s*\[|\bprocess\.env\b/;
      assert.doesNotMatch(source, apis, file);
      // No clock, time zone or locale: every date is the capture's own, so any computer converts it alike.
      const clock = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\b|\bprocess\.hrtime\b|\bIntl\.|\.toLocale\w*String\s*\(|\bgetTimezoneOffset\s*\(|\.get(?:FullYear|Month|Date|Day|Hours|Minutes|Seconds)\s*\(/;
      assert.doesNotMatch(source, clock, file);
    }
  });
});
