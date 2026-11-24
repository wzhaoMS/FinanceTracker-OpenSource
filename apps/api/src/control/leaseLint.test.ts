import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { LEASED_ROLES } from '../cli/leasedRoles.js';
import { API_SRC_DIR, REPO_ROOT } from './paths.js';

/**
 * The lease-aware path's lint rule (design §9.3 rule 2; deviation B-D3: the repository has no ESLint, so the rule is this
 * source scan, run with the API suite). From every lease-accepting Node role's entry point it follows the value imports
 * (type-only imports are erased and cannot start anything) and fails when any module other than `control/leasedSpawn.ts`
 * imports a process-starting module, or when a package outside the reviewed list enters the closure.
 */
const ROLE_ENTRIES = ['cli/leasedMain.ts'];
const SPAWN_MODULE = path.join(API_SRC_DIR, 'control/leasedSpawn.ts');
const PROCESS_MODULES = new Set(['child_process', 'cluster']);
/**
 * Reviewed packages a leased role may load; none of them starts a process (checked by the last test): the SQLite binding,
 * and the HTML and CSS parsers of the shared release verifier.
 */
const REVIEWED_PACKAGES = new Set(['better-sqlite3', 'parse5', 'css-tree']);
const BUILTINS = new Set(builtinModules);

interface Import { readonly specifier: string; readonly line: number }

/** Value imports of one source file: static and re-exports (not `import type` / `export type`), dynamic `import()`, `require()`. */
export function valueImports(file: string, source: string): Import[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Import[] = [];
  const add = (node: ts.Node, specifier: ts.Expression | undefined) => {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      found.push({ specifier: specifier.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) add(node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) add(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0]);
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const sharedExports = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/shared/package.json'), 'utf8')) as { exports: Record<string, { import: string }> };
  // The package exports compiled files; the lint follows each one back to its TypeScript source.
  return Object.fromEntries(Object.entries(pkg.exports).map(([key, target]) =>
    [key, target.import.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts')])) as Record<string, string>;
})();

type Resolved = { kind: 'file'; file: string } | { kind: 'builtin'; name: string } | { kind: 'package'; name: string };

function resolve(from: string, specifier: string): Resolved {
  if (specifier.startsWith('node:')) return { kind: 'builtin', name: specifier.slice(5).split('/')[0] };
  if (specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(from), specifier);
    const candidates = specifier.endsWith('.js')
      ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base]
      : [base, `${base}.ts`, path.join(base, 'index.ts')];
    const file = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!file) throw new Error(`unresolved ${specifier} from ${from}`);
    return { kind: 'file', file };
  }
  if (specifier === '@finance-tracker/shared' || specifier.startsWith('@finance-tracker/shared/')) {
    const key = `.${specifier.slice('@finance-tracker/shared'.length)}`;
    const target = sharedExports[key];
    if (!target) throw new Error(`unknown shared export ${specifier}`);
    return { kind: 'file', file: path.join(REPO_ROOT, 'packages/shared', target) };
  }
  const name = specifier.split('/')[0];
  if (BUILTINS.has(name)) return { kind: 'builtin', name };
  return { kind: 'package', name: specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : name };
}

export function leaseClosure(entries: readonly string[]) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const processImports: string[] = [];
  const queue = entries.map((entry) => path.join(API_SRC_DIR, entry));
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const { specifier, line } of valueImports(file, fs.readFileSync(file, 'utf8'))) {
      const target = resolve(file, specifier);
      if (target.kind === 'file') queue.push(target.file);
      else if (target.kind === 'package') packages.add(target.name);
      else if (PROCESS_MODULES.has(target.name)) processImports.push(`${path.relative(REPO_ROOT, file).split(path.sep).join('/')}:${line} ${specifier}`);
    }
  }
  return { files, packages, processImports };
}

describe('lease-aware path lint rule (§9.3 rule 2, B-D3)', () => {
  it('lets only control/leasedSpawn.ts start processes in the lease-accepting roles', () => {
    const closure = leaseClosure(ROLE_ENTRIES);
    expect(closure.files.has(SPAWN_MODULE)).toBe(true);
    expect(closure.processImports.every((entry) => entry.startsWith('apps/api/src/control/leasedSpawn.ts:'))).toBe(true);
    expect(closure.processImports.length).toBeGreaterThan(0);
    // The ordinary bounded runner (a plain spawn) must never be reachable from a leased role.
    expect(closure.files.has(path.join(API_SRC_DIR, 'control/exec.ts'))).toBe(false);
    expect(closure.files.has(path.join(API_SRC_DIR, 'ingress/boundedCommand.ts'))).toBe(false);
    expect(closure.files.has(path.join(API_SRC_DIR, 'control/maintenance.ts'))).toBe(false);
    expect([...closure.packages].filter((name) => !REVIEWED_PACKAGES.has(name))).toEqual([]);
  });

  it('detects every form of a process import and ignores types and comments', () => {
    const imports = valueImports('fixture.ts', [
      "// import { spawn } from 'node:child_process';",
      "/* require('child_process') */",
      "import type { ChildProcess } from 'node:child_process';",
      "export type { SpawnOptions } from 'child_process';",
      "import { execFile } from 'node:child_process';",
      "import * as cp from 'child_process';",
      "export { fork } from 'node:child_process';",
      "const later = () => import('node:child_process');",
      "const old = require('child_process');",
      "import cluster = require('cluster');",
      "const text = 'import x from \"child_process\"';",
    ].join('\n')).map((entry) => `${entry.line} ${entry.specifier}`);
    expect(imports).toEqual([
      '5 node:child_process', '6 child_process', '7 node:child_process', '8 node:child_process', '9 child_process', '10 cluster',
    ]);
  });

  it('the reviewed packages contain no process-starting module', () => {
    const roots: Record<string, string> = { 'better-sqlite3': 'lib', parse5: 'dist', 'css-tree': 'lib' };
    for (const [name, dir] of Object.entries(roots)) {
      const stack = [path.join(REPO_ROOT, 'node_modules', name, dir)];
      let scanned = 0;
      while (stack.length) {
        const current = stack.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const file = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(file);
          else if (/\.(c|m)?js$/.test(entry.name)) {
            scanned += 1;
            expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(/child_process|\bcluster\b['"]/);
          }
        }
      }
      expect(scanned, name).toBeGreaterThan(0);
    }
  });

  it('holdr-leased.sh accepts exactly the Node lease roles and execs one Node process with the loader', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/holdr-leased.sh'), 'utf8');
    const roles = /\n {2}([a-z|-]+)\) shift ;;/.exec(script)?.[1].split('|');
    expect(roles).toEqual([...LEASED_ROLES]);
    expect(script).toMatch(/\nexec "\$NODE" --import "\$T\/node_modules\/tsx\/dist\/loader\.mjs" "\$T\/apps\/api\/src\/cli\/leasedMain\.ts" "\$role" "\$@"\n/);
    const code = script.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    expect(code).not.toMatch(/\b(npm|npx)\b|node_modules\/\.bin\/tsx|\btsx\s/);
  });
});
