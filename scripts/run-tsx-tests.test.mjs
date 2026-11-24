import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/run-tsx-tests.mjs, which the tsx unit-test scripts run, in a scratch package whose tsx is a stand-in that reports how
// it was started; the last test uses the real tsx.
const runner = fileURLToPath(new URL('./run-tsx-tests.mjs', import.meta.url));
const posix = { skip: process.platform === 'win32' };
// Node's test runner runs no files when NODE_TEST_CONTEXT says it was started from a test file, as this one's children would be.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

// The stand-in's bin prints how it was started as JSON and exits with STUB_EXIT. With STUB_WAIT it prints "ready" and waits:
// SIGINT or SIGTERM makes it print the signal's name and exit with STUB_EXIT, or, with STUB_DIE, die of the signal.
const STUB = `
const exitCode = Number(process.env.STUB_EXIT ?? 0);
if (process.env.STUB_WAIT) {
  const timer = setInterval(() => {}, 1000);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (process.env.STUB_DIE) { process.removeAllListeners(signal); process.kill(process.pid, signal); return; }
      process.stdout.write('got ' + signal + '\\n');
      clearInterval(timer);
      process.exitCode = exitCode;
    });
  }
  process.stdout.write('ready\\n');
} else {
  process.stdout.write(JSON.stringify({ execPath: process.execPath, cwd: process.cwd(), args: process.argv.slice(2) }));
  process.exitCode = exitCode;
}
`;

async function scratchPackage(files, { tsx = 'stub' } = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'run-tsx-tests-')));
  await mkdir(path.join(dir, 'node_modules'));
  if (tsx === 'stub') {
    await mkdir(path.join(dir, 'node_modules', 'tsx'));
    await writeFile(path.join(dir, 'node_modules', 'tsx', 'package.json'), JSON.stringify({ name: 'tsx', bin: { tsx: './cli.mjs' } }));
    await writeFile(path.join(dir, 'node_modules', 'tsx', 'cli.mjs'), STUB);
  } else {
    const realTsx = path.dirname(createRequire(import.meta.url).resolve('tsx/package.json'));
    await symlink(realTsx, path.join(dir, 'node_modules', 'tsx'), 'junction');
  }
  for (const [file, text = ''] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const run = (cwd, args, extra = {}) => spawnSync(process.execPath, [runner, ...args], { cwd, encoding: 'utf8', env: { ...env, ...extra } });

test('the files under <dir> that end in <suffix>, sorted and relative, follow the options and --, run by this Node from the package', async () => {
  const p = await scratchPackage({
    'src/b/c.test.ts': '', 'src/a.test.ts': '', 'src/B.test.ts': '', 'src/b c/space.test.ts': '',
    'src/z.test.tsx': '', 'src/x.ts': '', 'src/a.test.ts.orig': '', 'src/b/Upper.TEST.ts': '', 'lib/l.test.ts': '',
    'src/node_modules/m.test.ts': '', 'src/b/node_modules/pkg/n.test.ts': '', 'src/.hidden/h.test.ts': '', 'src/.dot.test.ts': '',
    'src/b/.cache/d.test.ts': '',
  });
  try {
    const options = ['--test-name-pattern=a b', '--test-reporter', 'tap', '--test-skip-pattern', 'c d', '--test-only',
      '--import=./setup.mjs', '--tsconfig', 'tsconfig.json', '--test-reporter-destination', 'stdout'];
    const result = run(p.dir, ['src', '.test.ts', ...options]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, 'run-tsx-tests: 4 files ending in .test.ts under src/\n');
    assert.deepEqual(JSON.parse(result.stdout), {
      execPath: process.execPath,
      cwd: p.dir,
      args: ['--test', ...options, '--', 'src/B.test.ts', 'src/a.test.ts', 'src/b c/space.test.ts', 'src/b/c.test.ts'],
    });
    // A nested directory, however it is written, and no options.
    const nested = run(p.dir, [`.${path.sep}src${path.sep}b${path.sep}`, '.test.ts']);
    assert.equal(nested.status, 0, nested.stderr);
    assert.deepEqual(JSON.parse(nested.stdout).args, ['--test', '--', 'src/b/c.test.ts']);
  } finally { await p.cleanup(); }
});

test('a symlinked file counts; a symlinked directory is not walked, so a link loop is harmless', posix, async () => {
  const p = await scratchPackage({ 'src/a.test.ts': '', 'lib/l.test.ts': '', 'lib/deep/k.test.ts': '' });
  try {
    await symlink('../lib/l.test.ts', path.join(p.dir, 'src/linked.test.ts'));
    await symlink('../lib', path.join(p.dir, 'src/lib'));
    await symlink('.', path.join(p.dir, 'src/loop'));
    const result = run(p.dir, ['src', '.test.ts']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).args, ['--test', '--', 'src/a.test.ts', 'src/linked.test.ts']);
  } finally { await p.cleanup(); }
});

test('an argument that is neither an option nor a known option\'s value is refused (64) before anything starts', async () => {
  const p = await scratchPackage({ 'src/a.test.ts': '' });
  const refused = (stray) => `run-tsx-tests: ${JSON.stringify(stray)} is not an option or an option's value; only options are `
    + 'passed on (a value after "=", or as the next argument of --test-name-pattern, --test-skip-pattern, --test-reporter, '
    + '--test-reporter-destination, --test-concurrency, --test-timeout, --test-shard, --test-coverage-include, '
    + '--test-coverage-exclude, --test-coverage-branches, --test-coverage-functions, --test-coverage-lines, '
    + '--experimental-test-isolation, --tsconfig), and every file found always runs\n';
  try {
    for (const [options, stray] of [
      [['src/a.test.ts', '--test-name-pattern=x'], 'src/a.test.ts'],
      [['--test-name-pattern=x', 'src/a.test.ts'], 'src/a.test.ts'],
      // A separate value follows only an option of the runner's list (another option's goes after "=": --import=./setup.mjs).
      [['--test-only', 'src/a.test.ts'], 'src/a.test.ts'],
      [['--test-reporter', 'tap', 'spec'], 'spec'],
      [['--import', './setup.mjs'], './setup.mjs'],
      [['--test-name-pattern', '--', 'x'], '--'],
      [['--', '--test-name-pattern=x'], '--'],
      [['-'], '-'],
    ]) {
      const result = run(p.dir, ['src', '.test.ts', ...options]);
      assert.equal(result.status, 64, options.join(' '));
      assert.equal(result.stderr, refused(stray));
      assert.equal(result.stdout, '', 'tsx did not start');
    }
  } finally { await p.cleanup(); }
});

test('started inside a node:test test file (NODE_TEST_CONTEXT set), it refuses instead of letting Node skip every file', async () => {
  const p = await scratchPackage({ 'src/a.test.ts': '' });
  try {
    // Under `node --test` this file's own NODE_TEST_CONTEXT is inherited, as in any nested run; run alone, it is set here.
    const result = spawnSync(process.execPath, [runner, 'src', '.test.ts'], {
      cwd: p.dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? 'child-v8' },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `run-tsx-tests: NODE_TEST_CONTEXT=${process.env.NODE_TEST_CONTEXT ?? 'child-v8'} is set, as in a `
      + 'node:test test file, where Node\'s test runner would skip every file and pass; start this without it\n');
    assert.equal(result.stdout, '', 'tsx did not start');
  } finally { await p.cleanup(); }
});

test('no matching file, a missing directory or a file instead of one fails loudly without starting the tests', async () => {
  const p = await scratchPackage({ 'src/x.ts': '', 'src/node_modules/m.test.ts': '', 'src/.hidden/h.test.ts': '', 'src/.d.test.ts': '' });
  const none = (suffix) => `no files ending in ${suffix} under src/ (in ${p.dir}; node_modules and dot entries are skipped), `
    + 'so no tests would run';
  try {
    for (const [args, message] of [
      [['src', '.test.ts'], none('.test.ts')],
      [['src', '.spec.ts'], none('.spec.ts')],
      [['tests/unit', '.test.ts'], `tests/unit/ does not exist (in ${p.dir})`],
      [['src/x.ts', '.test.ts'], `src/x.ts/ is not a directory (in ${p.dir})`],
    ]) {
      const result = run(p.dir, args);
      assert.equal(result.status, 1, args.join(' '));
      assert.equal(result.stderr, `run-tsx-tests: ${message}\n`);
      assert.equal(result.stdout, '', 'the tests did not start');
    }
  } finally { await p.cleanup(); }
});

test('usage errors exit 64: no or bad arguments, a directory that is not below the package or looks like an option', async () => {
  const p = await scratchPackage({ 'src/a.test.ts': '', '-src/a.test.ts': '' });
  try {
    for (const [args, message] of [
      [[], 'usage: run-tsx-tests.mjs <dir> <suffix> [options for node --test...]'],
      [['src'], 'usage: run-tsx-tests.mjs <dir> <suffix> [options for node --test...]'],
      [['src', 'a/b.test.ts'], 'usage: run-tsx-tests.mjs <dir> <suffix> [options for node --test...]'],
      [['.', '.test.ts'], `. is not a subdirectory of ${p.dir}`],
      [['..', '.test.ts'], `.. is not a subdirectory of ${p.dir}`],
      [['src/../..', '.test.ts'], `src/../.. is not a subdirectory of ${p.dir}`],
      [[path.dirname(p.dir), '.test.ts'], `${path.dirname(p.dir)} is not a subdirectory of ${p.dir}`],
      [['-src', '.test.ts'], '-src starts with "-": Node would read the files under it as options'],
    ]) {
      const result = run(p.dir, args);
      assert.equal(result.status, 64, args.join(' '));
      assert.equal(result.stderr, `run-tsx-tests: ${message}\n`);
      assert.equal(result.stdout, '');
    }
  } finally { await p.cleanup(); }
});

test('a path that Node 21 and later would read as a glob pattern is refused, not passed on to be skipped', async () => {
  const p = await scratchPackage({ 'src/ok.test.ts': '', 'src/[id].test.ts': '', 'src/f(1).test.ts': '', 'src/x{1,2}/y.test.ts': '' });
  try {
    const result = run(p.dir, ['src', '.test.ts']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'run-tsx-tests: Node 21 and later would read these paths as glob patterns and could skip them; rename '
      + 'them: src/[id].test.ts, src/f(1).test.ts, src/x{1,2}/y.test.ts\n');
    assert.equal(result.stdout, '');
  } finally { await p.cleanup(); }
});

test('the exit status is the tests\' own', async () => {
  const p = await scratchPackage({ 'src/a.test.ts': '' });
  try {
    for (const code of [1, 3]) assert.equal(run(p.dir, ['src', '.test.ts'], { STUB_EXIT: String(code) }).status, code);
  } finally { await p.cleanup(); }
});

function start(cwd, extra) {
  const child = spawn(process.execPath, [runner, 'src', '.test.ts'], { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let onReady;
  const ready = new Promise((resolve) => { onReady = resolve; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; if (stdout.includes('ready\n')) onReady(); });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout })));
  return { child, ready, closed };
}

test('SIGINT and SIGTERM sent to the runner alone reach the tests, and their status is the runner\'s', { ...posix, timeout: 30_000 }, async () => {
  const p = await scratchPackage({ 'src/a.test.ts': '' });
  try {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const job = start(p.dir, { STUB_WAIT: '1', STUB_EXIT: '7' });
      await job.ready;
      job.child.kill(signal);
      assert.deepEqual(await job.closed, { code: 7, signal: null, stdout: `ready\ngot ${signal}\n` });
    }
    // Tests that die of the signal: 128 + its number, as a shell reports it.
    const job = start(p.dir, { STUB_WAIT: '1', STUB_DIE: '1' });
    await job.ready;
    job.child.kill('SIGTERM');
    assert.deepEqual(await job.closed, { code: 143, signal: null, stdout: 'ready\n' });
  } finally { await p.cleanup(); }
});

test('with the real tsx: TypeScript tests run, a failing one fails the run, and --test-name-pattern picks tests', { timeout: 60_000 }, async () => {
  const p = await scratchPackage({
    'src/sum.test.ts': [
      'import { test } from \'node:test\';',
      'import assert from \'node:assert/strict\';',
      'const sum = (a: number, b: number): number => a + b;',
      'test(\'adds\', () => assert.equal(sum(1, 2), 3));',
      '',
    ].join('\n'),
    'src/nested/fails.test.ts': [
      'import { test } from \'node:test\';',
      'test(\'fails on purpose\', (): void => { throw new Error(\'expected\'); });',
      '',
    ].join('\n'),
  }, { tsx: 'real' });
  try {
    const all = run(p.dir, ['src', '.test.ts', '--test-reporter', 'tap']);
    assert.equal(all.status, 1, all.stdout + all.stderr);
    assert.match(all.stdout, /^ok \d+ - adds$/m);
    assert.match(all.stdout, /^not ok \d+ - fails on purpose$/m);
    assert.match(all.stdout, /^# tests 2$/m);
    assert.match(all.stdout, /^# pass 1$/m);
    assert.match(all.stdout, /^# fail 1$/m);
    for (const pattern of [['--test-name-pattern=^adds$'], ['--test-name-pattern', '^adds$']]) {
      const picked = run(p.dir, ['src', '.test.ts', '--test-reporter=tap', ...pattern]);
      assert.equal(picked.status, 0, picked.stdout + picked.stderr);
      assert.match(picked.stdout, /^ok \d+ - adds$/m);
      assert.doesNotMatch(picked.stdout, /^not ok/m);
      assert.match(picked.stdout, /^# fail 0$/m);
    }
  } finally { await p.cleanup(); }
});

// A TypeScript test file that notes in ran.txt, beside src/, that it was loaded; and every file under src/, as bytes.
const markedTest = (name, body) => 'import { appendFileSync } from \'node:fs\';\n'
  + `appendFileSync(new URL('../ran.txt', import.meta.url), '${name}\\n');\nimport { test } from 'node:test';\n${body}`;
const sources = async (dir) => Object.fromEntries(await Promise.all((await readdir(path.join(dir, 'src'))).sort()
  .map(async (name) => [`src/${name}`, await readFile(path.join(dir, 'src', name))])));
const asBytes = (files) => Object.fromEntries(Object.entries(files).map(([file, text]) => [file, Buffer.from(text)]));

test('with the real tsx: an option missing its value fails before any test runs and leaves every test file as it was', { timeout: 60_000 }, async () => {
  // Without the -- before the files, Node took src/a.test.ts as the missing value: as the name pattern (a passing run without
  // that file), as the report file (overwritten with TAP), or as a module to preload.
  const files = {
    'src/a.test.ts': markedTest('a', 'test(\'alpha\', (): void => { throw new Error(\'must not run\'); });\n'),
    'src/b.test.ts': markedTest('b', 'test(\'beta\', () => {});\n'),
  };
  const p = await scratchPackage(files, { tsx: 'real' });
  try {
    assert.deepEqual(await sources(p.dir), asBytes(files));
    for (const [options, missing] of [
      [['--test-name-pattern'], '--test-name-pattern'],
      [['--test-reporter=tap', '--test-reporter-destination'], '--test-reporter-destination'],
      [['--import'], '--import'],
    ]) {
      const result = run(p.dir, ['src', '.test.ts', ...options]);
      assert.notEqual(result.status, 0, options.join(' '));
      // Node's own option parser ends this message with \r\n on Windows.
      assert.match(result.stderr, new RegExp(`: ${missing} requires an argument\\r?\\n`));
      assert.equal(result.stdout, '', 'no test reported');
      assert.equal(existsSync(path.join(p.dir, 'ran.txt')), false, 'no test file was loaded');
      assert.deepEqual(await sources(p.dir), asBytes(files), 'every test file is byte for byte the same, and no file was added');
    }
    // The control: without the bad option both files load, and the failing test fails the run.
    const control = run(p.dir, ['src', '.test.ts', '--test-reporter=tap']);
    assert.equal(control.status, 1, control.stdout + control.stderr);
    assert.deepEqual((await readFile(path.join(p.dir, 'ran.txt'), 'utf8')).split('\n').sort(), ['', 'a', 'b']);
  } finally { await p.cleanup(); }
});

test('with the real tsx: --tsconfig without a path, and options that would end the run, are refused before any test loads', { timeout: 60_000 }, async () => {
  // tsx reads --tsconfig, -e/--eval and -p/--print itself, so Node never checks them, and it silently dropped an empty one: the
  // run went on and passed. These tests all pass, so only the exit status, ran.txt and the bytes tell such a run apart.
  const files = {
    'src/a.test.ts': markedTest('a', 'test(\'alpha\', () => {});\n'),
    'src/b.test.ts': markedTest('b', 'test(\'beta\', () => {});\n'),
  };
  const p = await scratchPackage({ ...files, 'tsconfig.json': '{ "compilerOptions": { "target": "ES2022" } }\n' }, { tsx: 'real' });
  const ran = path.join(p.dir, 'ran.txt');
  const needsPath = 'run-tsx-tests: --tsconfig needs a path, as --tsconfig=<file> or --tsconfig <file>: tsx reads it itself and '
    + 'would silently ignore it without one\n';
  const ends = (option) => `run-tsx-tests: ${JSON.stringify(option)} would end the run before any test: -e/--eval and -p/--print `
    + 'cannot run beside --test (tsx drops an empty one), and -h/--help, -v/--version, --v8-options and --completion-bash only '
    + 'print something; run tsx or node directly for those\n';
  try {
    for (const [options, message] of [
      [['--tsconfig'], needsPath],
      [['--tsconfig', '--test-name-pattern=^beta$'], needsPath],
      [['--tsconfig='], needsPath],
      [['--tsconfig', ''], needsPath],
      [['--tsconfig:'], needsPath],
      ...['-e', '--eval', '--eval=', '-p', '--print=1', '-pe', '-v', '--version', '-h', '--help', '--v8-options', '--completion-bash']
        .map((option) => [[option], ends(option)]),
    ]) {
      const result = run(p.dir, ['src', '.test.ts', ...options]);
      assert.equal(result.status, 64, JSON.stringify(options));
      assert.equal(result.stderr, message);
      assert.equal(result.stdout, '', 'nothing ran');
      assert.equal(existsSync(ran), false, 'no test file was loaded');
      assert.deepEqual(await sources(p.dir), asBytes(files), 'every test file is byte for byte the same');
    }
    // A path, written either way, goes to tsx, which runs the tests with it, or reports a missing file before any test.
    for (const options of [['--tsconfig', './tsconfig.json'], ['--tsconfig=./tsconfig.json']]) {
      const result = run(p.dir, ['src', '.test.ts', '--test-reporter=tap', ...options]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual((await readFile(ran, 'utf8')).split('\n').sort(), ['', 'a', 'b']);
      await rm(ran);
    }
    const absent = run(p.dir, ['src', '.test.ts', '--tsconfig=./absent.json']);
    assert.ok(![0, 64].includes(absent.status), `tsx reports it: ${absent.status} ${absent.stderr}`);
    assert.equal(existsSync(ran), false, 'no test file was loaded');
    assert.deepEqual(await sources(p.dir), asBytes(files));
  } finally { await p.cleanup(); }
});
