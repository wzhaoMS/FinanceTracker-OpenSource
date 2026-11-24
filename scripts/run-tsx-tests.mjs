// Runs a package's TypeScript unit tests with tsx's test runner (node:test), on Node 20 and later, on macOS, Linux and Windows:
//
//   node ../../scripts/run-tsx-tests.mjs <dir> <suffix> [options for node --test...]
//
// e.g. "test": "node ../../scripts/run-tsx-tests.mjs src .test.ts". The scripts used to run `tsx --test "src/**/*.test.ts"`,
// which hands the quoted pattern to Node's test runner, and only Node 21 and later expand patterns there: Node 20 looks for a
// file named `src/**/*.test.ts` and stops ("Could not find"), and from Node 21 a pattern that matches nothing runs no tests and
// passes. So this script finds the files itself, the way Node 22's runner expanded `<dir>/**/*<suffix>`: it walks <dir> (a
// subdirectory of the current directory, the package's when npm runs it), skips node_modules and every name that starts with a
// dot, does not descend into symlinked directories, and keeps the files whose names end in <suffix>, case-sensitively on every
// platform. No such file is an error. Otherwise it runs `node <tsx's bin> --test [options...] -- <files...>` with this Node,
// from this directory: the tsx the package resolves, started without its .bin shim (a .cmd file on Windows). The files are
// sorted paths relative to this directory, with `/`. Node 21 and later read each one as a glob pattern, so a path containing one
// of * ? [ ] { } ( ) \ is refused rather than silently skipped there.
//
// The options are what npm passes after `--`, such as `--test-name-pattern=parser`. They go before the files, where Node reads
// them as options, and `--` ends them, so an option missing its value fails ("requires an argument") instead of taking the
// first file as its value (`--test-reporter-destination` would overwrite it). Every argument must be an option or an option's
// value. A value is accepted after `=`, or as the next argument of one of SPLIT_VALUE_OPTIONS (unless it starts with "-", which
// Node does not take as a value either); the runner cannot know every option that takes one. Anything else, a file path above
// all, is refused: Node would read it and everything after it as more files (and from Node 21 silently drop those that match
// nothing), while the runner always runs every file it finds.
//
// tsx reads some options itself, so Node never checks them, and tsx silently drops an empty value. The runner therefore
// requires a path for --tsconfig and refuses the options that would end the run before any test: tsx's -e/--eval and
// -p/--print (Node refuses code beside --test) and the ones that only print something and exit 0 (help, version, V8 options,
// bash completion). Like tsx, it ends an option's name at the first "=", "." or ":" and reads "-pe" as -p and -e.
//
// Started from inside a node:test test file (NODE_TEST_CONTEXT set), Node's test runner would skip every file and pass, so the
// runner refuses to start there rather than clearing the variable, which is Node's guard against a test that starts test runs
// (a test running its own suite would recurse); a test that means to run a suite starts it without the variable. Exit status:
// the tests' own (128 + n when signal n ended tsx); 1 when no file matches, the files cannot be listed or run, or
// NODE_TEST_CONTEXT is set; 64 for a usage error. SIGINT and SIGTERM, the signals npm passes on to a script and tsx to its
// child, are passed on to the tests, except on Windows, where Ctrl-C already reaches every process in the console (and a
// forwarded one would end tsx abruptly). Plain Node (20.0 APIs), no dependency.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// What makes Node 21+'s test runner read a path as a pattern (its glob keeps a leading `!` or `#` literal).
const GLOB_SPECIAL = /[*?[\]{}()\\]/;
const SIGNALS = ['SIGINT', 'SIGTERM'];
// Options of node --test (Node 20 and 22) and tsx that take a value, which may also be the next argument.
const SPLIT_VALUE_OPTIONS = new Set([
  '--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination', '--test-concurrency',
  '--test-timeout', '--test-shard', '--test-coverage-include', '--test-coverage-exclude', '--test-coverage-branches',
  '--test-coverage-functions', '--test-coverage-lines', '--experimental-test-isolation', '--tsconfig',
]);
// Options that would end the run before any test; as single letters (tsx's aliases): e, p, h, v.
const ENDING_OPTIONS = new Set(['--eval', '--print', '--help', '--version', '--v8-options', '--completion-bash']);
const ENDING_LETTERS = /[ephv]/;

function stop(message, code = 1) {
  process.stderr.write(`run-tsx-tests: ${message}\n`);
  process.exitCode = code;
}

/** Why the forwarded `options` cannot be passed on, or undefined. */
function refusal(options) {
  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    if (option === '--' || option === '-' || !option.startsWith('-')) {
      return `${JSON.stringify(option)} is not an option or an option's value; only options are passed on (a value after "=", `
        + `or as the next argument of ${[...SPLIT_VALUE_OPTIONS].join(', ')}), and every file found always runs`;
    }
    const end = option.search(/[.:=]/);
    const name = end === -1 ? option : option.slice(0, end);
    if (option.startsWith('--') ? ENDING_OPTIONS.has(name) : ENDING_LETTERS.test(name)) {
      return `${JSON.stringify(option)} would end the run before any test: -e/--eval and -p/--print cannot run beside --test `
        + '(tsx drops an empty one), and -h/--help, -v/--version, --v8-options and --completion-bash only print something; '
        + 'run tsx or node directly for those';
    }
    if (name === '--tsconfig') {
      let value = end === -1 ? undefined : option.slice(end + 1);
      if (end === -1 && i + 1 < options.length && !options[i + 1].startsWith('-')) value = options[(i += 1)];
      if (!value) {
        return '--tsconfig needs a path, as --tsconfig=<file> or --tsconfig <file>: tsx reads it itself and would silently '
          + 'ignore it without one';
      }
    } else if (SPLIT_VALUE_OPTIONS.has(option) && i + 1 < options.length && !options[i + 1].startsWith('-')) {
      i += 1;
    }
  }
  return undefined;
}

/** The files under `root` whose names end in `suffix`, as `/`-separated paths that start with `prefix`, sorted. */
function findTestFiles(root, prefix, suffix) {
  const files = [];
  const walk = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const entryRelative = `${relative}/${entry.name}`;
      // A symlink is not a directory here, so a linked directory is never walked (nor can a link loop).
      if (entry.isDirectory()) walk(path.join(directory, entry.name), entryRelative);
      else if (entry.name.endsWith(suffix)) files.push(entryRelative);
    }
  };
  walk(root, prefix);
  return files.sort();
}

/** The file that the package's `tsx` command runs (its package.json `bin`), resolved from `cwd` as npm's .bin shim would be. */
function tsxCli(cwd) {
  const manifest = createRequire(path.join(cwd, 'package.json')).resolve('tsx/package.json');
  const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const cli = typeof bin === 'string' ? bin : bin?.tsx;
  if (typeof cli !== 'string') throw new Error(`${manifest} names no tsx command`);
  return path.resolve(path.dirname(manifest), cli);
}

function main([dir, suffix, ...options]) {
  if (!dir || !suffix || /[/\\]/.test(suffix)) {
    return stop('usage: run-tsx-tests.mjs <dir> <suffix> [options for node --test...]', 64);
  }
  const refused = refusal(options);
  if (refused !== undefined) return stop(refused, 64);
  const cwd = process.cwd();
  const root = path.resolve(cwd, dir);
  const prefix = path.relative(cwd, root).split(path.sep).join('/');
  if (prefix === '' || prefix === '..' || prefix.startsWith('../') || path.isAbsolute(prefix)) {
    return stop(`${dir} is not a subdirectory of ${cwd}`, 64);
  }
  // Every file is passed as <prefix>/..., so the prefix must not look like an option.
  if (prefix.startsWith('-')) return stop(`${dir} starts with "-": Node would read the files under it as options`, 64);
  // Node's test runner treats a set NODE_TEST_CONTEXT (even empty) as "inside a test file": it then skips every file and passes.
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    return stop(`NODE_TEST_CONTEXT=${process.env.NODE_TEST_CONTEXT} is set, as in a node:test test file, where Node's test runner `
      + 'would skip every file and pass; start this without it');
  }
  const shown = `${prefix}/`;
  let files;
  try {
    if (!fs.statSync(root).isDirectory()) return stop(`${shown} is not a directory (in ${cwd})`);
    files = findTestFiles(root, prefix, suffix);
  } catch (error) {
    const missing = error.code === 'ENOENT' && error.path === root;
    return stop(missing ? `${shown} does not exist (in ${cwd})` : `cannot list ${shown}: ${error.message}`);
  }
  if (files.length === 0) {
    return stop(`no files ending in ${suffix} under ${shown} (in ${cwd}; node_modules and dot entries are skipped), `
      + 'so no tests would run');
  }
  const special = files.filter((file) => GLOB_SPECIAL.test(file));
  if (special.length > 0) {
    return stop(`Node 21 and later would read these paths as glob patterns and could skip them; rename them: ${special.join(', ')}`);
  }
  let cli;
  try {
    cli = tsxCli(cwd);
  } catch (error) {
    return stop(`cannot find tsx from ${cwd} (npm ci installs it): ${error.message}`);
  }

  process.stderr.write(`run-tsx-tests: ${files.length} ${files.length === 1 ? 'file' : 'files'} ending in ${suffix} under ${shown}\n`);
  let child;
  try {
    child = spawn(process.execPath, [cli, '--test', ...options, '--', ...files], { stdio: 'inherit' });
  } catch (error) {
    return stop(`tsx (${cli}): ${error.message}`);
  }
  const relay = (signal) => {
    if (process.platform === 'win32') return;
    try { child.kill(signal); } catch { /* it has exited */ }
  };
  for (const signal of SIGNALS) process.on(signal, relay);
  child.once('error', (error) => stop(`tsx (${cli}): ${error.message}`));
  child.once('exit', (code, signal) => {
    for (const name of SIGNALS) process.removeListener(name, relay);
    process.exitCode = signal === null ? code : 128 + (os.constants.signals[signal] ?? 0);
  });
}

main(process.argv.slice(2));
