import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './paths.js';

/**
 * `tryLock` is the only way production code takes a control lock (B round 4; the seam PR D builds on). PR D asserts, in
 * `tryLock`'s first line (`assertDeviceLockAcquisition(file, mode)`), that a device callback never takes authorization.lock
 * or an exclusive lifecycle.lock; that holds for every acquisition only while no other code path can take a flock. On macOS
 * a flock comes from `open(2)` with `O_SHLOCK` or `O_EXLOCK` (Node has no flock API), so this source scan pins:
 *
 * 1. `tryLock(file, mode)` in control/lifecycle.ts makes exactly one `open` call, the one with `O_EXLOCK`/`O_SHLOCK`;
 * 2. every other `open`/`openSync` call in production code passes a string flag or only non-locking `O_*` flags (named
 *    `fs.constants` members, or constants built from them; a numeric literal other than 0 is refused, `0x10`/`0x20` included);
 * 3. `O_EXLOCK`/`O_SHLOCK` are named nowhere else in production code (only their declarations and `tryLock`);
 * 4. no production string names `lockf` or `flock` (a child process taking the lock instead);
 * 5. lifecycle.ts's lock helpers reach `tryLock`, directly or through `acquireLock`.
 */
const ROOTS = [path.join(REPO_ROOT, 'apps/api/src'), path.join(REPO_ROOT, 'packages/shared/src')];
const LIFECYCLE = path.join(REPO_ROOT, 'apps/api/src/control/lifecycle.ts');
/** Test-only modules (fixtures and helpers that are not named `*.test.ts`). */
const TEST_HELPERS = new Set(['apps/api/src/control/testControl.ts', 'apps/api/src/control/testDirs.ts', 'apps/api/src/ingress/fixtures.ts',
  'apps/api/src/ingress/nativeFixtures.ts', 'apps/api/src/ingress/cliFixtures.ts']);
const NON_LOCKING_FLAGS = new Set(['O_RDONLY', 'O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_EXCL', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_TRUNC', 'O_APPEND',
  'O_DIRECTORY', 'O_SYNC', 'O_DSYNC', 'O_NOCTTY', 'O_SYMLINK', 'O_NOATIME']);
const LOCK_FLAGS = new Set(['O_EXLOCK', 'O_SHLOCK']);
const LOCK_HELPERS: Record<string, 'tryLock' | 'acquireLock'> = {
  acquireLock: 'tryLock', probeExclusive: 'tryLock', proveInheritedLease: 'tryLock', tryRecoveryLock: 'tryLock',
  acquireSharedLease: 'acquireLock', acquireExclusiveLease: 'acquireLock', withAuthorizationLock: 'acquireLock',
};

function productionFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['testing', '__fixtures__', '__tests__', 'node_modules'].includes(entry.name)) walk(full);
      } else if (/\.[cm]?[jt]s$/.test(entry.name) && !/\.(test|integration|spec|bench)\.[cm]?[jt]s$/.test(entry.name)
        && !entry.name.endsWith('.d.ts') && !TEST_HELPERS.has(path.relative(REPO_ROOT, full))) {
        files.push(full);
      }
    }
  };
  for (const root of ROOTS) walk(root);
  return files.sort();
}

const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
  /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

function where(sf: ts.SourceFile, node: ts.Node): string {
  return `${path.relative(REPO_ROOT, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
}

/** The enclosing function declaration's name, if any. */
function enclosingFunction(node: ts.Node): string | null {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isFunctionDeclaration(at)) return at.name?.text ?? null;
  }
  return null;
}

/** The file's `const` initializers and its names destructured from a `constants` object (`const { O_RDONLY } = fs.constants`). */
function bindings(sf: ts.SourceFile) {
  const consts = new Map<string, ts.Expression>();
  const fromConstants = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isVariableDeclarationList(node.parent)
      && node.parent.flags & ts.NodeFlags.Const) {
      if (ts.isIdentifier(node.name)) consts.set(node.name.text, node.initializer);
      else if (ts.isObjectBindingPattern(node.name) && /(^|\.)constants$/.test(node.initializer.getText(sf))) {
        for (const element of node.name.elements) {
          if (!element.propertyName && ts.isIdentifier(element.name)) fromConstants.add(element.name.text);
        }
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(node:)?fs(\/promises)?$/.test(node.moduleSpecifier.text)) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const element of named.elements) if (!element.propertyName) fromConstants.add(element.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { consts, fromConstants };
}

/** True when `expr`, an open flags argument, can only hold non-locking flags. */
function nonLockingFlags(expr: ts.Expression, sf: ts.SourceFile, scope: ReturnType<typeof bindings>, seen = new Set<string>()): boolean {
  if (ts.isStringLiteralLike(expr)) return true;
  if (ts.isParenthesizedExpression(expr)) return nonLockingFlags(expr.expression, sf, scope, seen);
  if (ts.isNumericLiteral(expr)) return Number(expr.text) === 0;
  if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expr.operatorToken.kind)) {
    return nonLockingFlags(expr.left, sf, scope, seen) && nonLockingFlags(expr.right, sf, scope, seen);
  }
  if (ts.isPropertyAccessExpression(expr)) return NON_LOCKING_FLAGS.has(expr.name.text) && /(^|\.)constants$/.test(expr.expression.getText(sf));
  if (ts.isIdentifier(expr)) {
    if (NON_LOCKING_FLAGS.has(expr.text) && scope.fromConstants.has(expr.text)) return true;
    const initializer = scope.consts.get(expr.text);
    if (!initializer || seen.has(expr.text)) return false;
    return nonLockingFlags(initializer, sf, scope, new Set([...seen, expr.text]));
  }
  return false;
}

describe('tryLock is the single control-lock acquisition seam (PR D\'s device-callback assertion hooks it)', () => {
  const files = productionFiles();

  it('scans the production sources, lifecycle.ts included', () => {
    expect(files).toContain(LIFECYCLE);
    expect(files.length).toBeGreaterThan(100);
  });

  it('tryLock(file, mode) makes exactly one open call, the only one with O_EXLOCK/O_SHLOCK', () => {
    const sf = parse(LIFECYCLE);
    const declaration = sf.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'tryLock');
    expect(declaration, 'tryLock is declared in control/lifecycle.ts').toBeDefined();
    expect(declaration!.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
    expect(declaration!.parameters.map((parameter) => parameter.name.getText(sf))).toEqual(['file', 'mode']);
    const opens: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ['open', 'openSync'].includes(calleeName(node) ?? '')) opens.push(node);
      ts.forEachChild(node, visit);
    };
    visit(declaration!.body!);
    expect(opens).toHaveLength(1);
    const flags = opens[0].arguments[1]?.getText(sf) ?? '';
    expect(flags).toMatch(/\bO_EXLOCK\b/);
    expect(flags).toMatch(/\bO_SHLOCK\b/);
  });

  it('no other open or openSync call in production code can take a lock', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sf = parse(file);
      const scope = bindings(sf);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ['open', 'openSync'].includes(calleeName(node) ?? '') && node.arguments.length >= 2) {
          const inTryLock = file === LIFECYCLE && enclosingFunction(node) === 'tryLock';
          if (!inTryLock && !nonLockingFlags(node.arguments[1], sf, scope)) offenders.push(`${where(sf, node)}: ${node.arguments[1].getText(sf)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });

  it('O_EXLOCK and O_SHLOCK are named only in their declarations and in tryLock; no production string names lockf or flock', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sf = parse(file);
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && LOCK_FLAGS.has(node.text)) {
          const declared = ts.isVariableDeclaration(node.parent) && node.parent.name === node;
          if (file !== LIFECYCLE || (!declared && enclosingFunction(node) !== 'tryLock')) offenders.push(`${where(sf, node)}: ${node.text}`);
        }
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
          && /\b(lockf|flock)\b/.test(node.text)) {
          offenders.push(`${where(sf, node)}: ${JSON.stringify(node.text)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });

  it('the lock helpers reach tryLock (directly or through acquireLock)', () => {
    const sf = parse(LIFECYCLE);
    const calls = new Map<string, Set<string>>();
    for (const statement of sf.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
      const called = new Set<string>();
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) called.add(node.expression.text);
        ts.forEachChild(node, visit);
      };
      visit(statement.body);
      calls.set(statement.name.text, called);
    }
    for (const [helper, via] of Object.entries(LOCK_HELPERS)) expect(calls.get(helper)?.has(via), `${helper} calls ${via}`).toBe(true);
  });

  it('the scan sees a bypass: a numeric lock flag, a lock constant elsewhere, a lockf child', () => {
    const probe = (text: string) => {
      const sf = ts.createSourceFile('/probe.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const scope = bindings(sf);
      const flags: boolean[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ['open', 'openSync'].includes(calleeName(node) ?? '')) flags.push(nonLockingFlags(node.arguments[1], sf, scope));
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return flags;
    };
    expect(probe("import fs from 'node:fs'; fs.openSync(f, fs.constants.O_RDONLY | 0x20);")).toEqual([false]);
    expect(probe("import fs from 'node:fs'; const SNEAKY = 0x10; fs.openSync(f, SNEAKY);")).toEqual([false]);
    expect(probe("import fs from 'node:fs'; const O_RDONLY = 0x20; fs.openSync(f, O_RDONLY);")).toEqual([false]);
    expect(probe("import { O_EXLOCK } from './lifecycle.js'; fs.openSync(f, O_EXLOCK);")).toEqual([false]);
    expect(probe("import fs from 'node:fs'; fs.openSync(f, flags());")).toEqual([false]);
    expect(probe("import fs from 'node:fs'; const { O_RDONLY, O_NOFOLLOW } = fs.constants; const F = O_RDONLY | (O_NOFOLLOW ?? 0); fs.openSync(f, F); fs.openSync(f, 'wx');"))
      .toEqual([true, true]);
  });
});
