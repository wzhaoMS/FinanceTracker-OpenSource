import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  installPlist, LABEL, main as renderMain, planLaunchAgent, renderPlist, RenderError, xmlText,
} from '../install/macos/render-plist.mjs';
import { AGENT_DIR, REPO_ROOT, tempDir } from './helpers.mjs';

const WINDOWS_DIR = path.join(AGENT_DIR, 'install', 'windows');
const DOCS = path.join(REPO_ROOT, 'docs', 'sync-agent.md');
const windows = process.platform === 'win32';
/** A Mac as render-plist sees it: the checkout, the home folder, and the node on PATH. */
const MAC = { platform: 'darwin', cwd: '/Users/sample/src/holdr', homedir: '/Users/sample', repo: '/Users/sample/src/holdr', execPath: '/opt/sample/bin/node' };
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const script = (name) => read(path.join(WINDOWS_DIR, name));
/** Where `pattern` first matches in `text`; it must match. */
const at = (text, pattern) => {
  const index = text.search(pattern);
  assert.notEqual(index, -1, String(pattern));
  return index;
};
/** One section of the install guide, from its heading to the next heading of the same or a higher level. */
function guideSection(heading) {
  const docs = read(DOCS);
  const start = at(docs, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  const rest = docs.slice(start + heading.length);
  const end = rest.search(new RegExp(`^#{1,${heading.indexOf(' ')}} `, 'm'));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Windows PowerShell 5.1, without a PowerShell 7 module path (which breaks its own modules). */
function powershell(args, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 120_000, windowsHide: true,
  });
}

/** The values of a property list's <string> elements, unescaped. */
const plistStrings = (xml) => [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));

/** A well-formed property list: tags closed in order, every & an entity, a valid comment; on macOS, plutil -lint agrees. */
function assertPlist(t, xml) {
  const stack = [];
  for (const [, closing, name, selfClosing] of xml.replace(/<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>/g)) {
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), name);
    else stack.push(name);
  }
  assert.deepEqual(stack, []);
  assert.doesNotMatch(xml, /&(?!(?:amp|lt|gt|quot|apos);)/, 'every & starts an entity');
  assert.doesNotMatch(xml.match(/<!--([\s\S]*?)-->/)[1], /--/, 'an XML comment cannot hold "--"');
  if (process.platform === 'darwin') {
    const file = path.join(tempDir(t), `${LABEL}.plist`);
    fs.writeFileSync(file, xml);
    const lint = spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
}

/** render-plist --print on the sample Mac: its exit status, the file and the errors. */
function printed(argv, options = {}) {
  let out = '';
  let err = '';
  const status = renderMain(['--print', ...argv], {
    ...MAC, env: {}, stdout: { write: (text) => { out += text; } }, stderr: { write: (text) => { err += text; } }, ...options,
  });
  return { status, out, err };
}

test('the Windows scripts need no administrator rights and no compiled helper', () => {
  const register = script('register-task.ps1');
  const unregister = script('unregister-task.ps1');
  const stop = script('stop-receiver.ps1');
  for (const forbidden of [/RunLevel Highest/i, /Add-Type/i, /\.cs\b/, /TaskHost/i, /Set-ExecutionPolicy/i]) {
    for (const text of [register, unregister, stop]) assert.doesNotMatch(text, forbidden);
  }
  assert.match(register, /\$powershell = Join-Path \$env:SystemRoot 'System32\\WindowsPowerShell\\v1\.0\\powershell\.exe'/);
  assert.match(register, /New-ScheduledTaskAction -Execute \$powershell /);
  assert.match(register, /-LogonType Interactive -RunLevel Limited/);
  assert.match(register, /New-ScheduledTaskTrigger -AtLogOn -User \$user/);
  assert.match(register, /-WindowStyle Hidden/);
  assert.match(register, /-MultipleInstances IgnoreNew/);
  assert.match(unregister, /Unregister-ScheduledTask -TaskName \$TaskName -TaskPath '\\' -Confirm:\$false/);
});

test('stopping on Windows ends the task\'s run, then the receiver itself (which outlives it); register and unregister stop it first', () => {
  const stop = script('stop-receiver.ps1');
  assert.ok(at(stop, /Stop-ScheduledTask -TaskName \$TaskName/) < at(stop, /Stop-Process -Id \$process\.ProcessId -Force/),
    'the task first, so that it does not start the receiver again');
  assert.match(stop, /Get-CimInstance Win32_Process -Filter "Name = 'node\.exe'"/);
  assert.match(stop, /\$_\.CommandLine -match \$CommandLinePattern -and \(Test-OwnProcess \$_\)/, 'only this account\'s receivers');
  assert.match(stop, /\[string\]\$CommandLinePattern = 'agents\[\\\\\/\]card-sync\[\\\\\/\]receiver\\\.mjs'/);
  assert.ok(at(stop, /Stop-Process/) < at(stop, /Wait-Process -Id \$ids/), 'it waits until the port is free');
  const call = /& \(Join-Path \$PSScriptRoot 'stop-receiver\.ps1'\) -TaskName \$TaskName/;
  const unregister = script('unregister-task.ps1');
  assert.ok(at(unregister, call) < at(unregister, /Unregister-ScheduledTask/));
  assert.doesNotMatch(unregister, /Stop-ScheduledTask|Stop-Process/, 'stopping is left to stop-receiver.ps1');
  const register = script('register-task.ps1');
  assert.match(register, /if \(-not \$NoStart\) \{ & \(Join-Path \$PSScriptRoot 'stop-receiver\.ps1'\) -TaskName \$TaskName \}/);
  assert.ok(at(register, call) < at(register, /Register-ScheduledTask -TaskName/));
  assert.ok(at(register, /Register-ScheduledTask -TaskName/) < at(register, /Start-ScheduledTask/));
});

test('stop-receiver.ps1 stops a running receiver and waits for it to exit, leaving other Node.js processes alone', { skip: !windows && 'Windows only' }, async (t) => {
  // A unique command line and task name, so that no real receiver or task on this computer is touched.
  const marker = `holdr-stop-test-${randomBytes(6).toString('hex')}`;
  const dir = path.join(tempDir(t), marker);
  fs.mkdirSync(dir);
  for (const name of ['receiver.mjs', 'bystander.mjs']) fs.writeFileSync(path.join(dir, name), 'setInterval(() => {}, 1000);\n');
  const receiver = spawn(process.execPath, [path.join(dir, 'receiver.mjs')], { stdio: 'ignore', windowsHide: true });
  const bystander = spawn(process.execPath, [path.join(dir, 'bystander.mjs')], { stdio: 'ignore', windowsHide: true });
  t.after(() => { receiver.kill(); bystander.kill(); });
  const exited = new Promise((resolve) => receiver.once('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const args = ['-File', path.join(WINDOWS_DIR, 'stop-receiver.ps1'), '-TaskName', `Holdr Card Sync Stop Test ${marker}`,
    '-CommandLinePattern', `${marker}[\\\\/]receiver\\.mjs`];
  const stopped = powershell(args);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, new RegExp(`Stopped the receiver \\(process ${receiver.pid}\\)`));
  assert.doesNotMatch(stopped.stdout, /Stopped the task/, 'there is no such task');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('the receiver is still running')), 10_000))]);
  assert.equal(bystander.exitCode, null, 'another Node.js process keeps running');
  assert.match(powershell(args).stdout, /No receiver was running/);
});

test('the Windows task: current user, at logon, least privilege, hidden window, one instance, Node running the receiver', { skip: !windows && 'Windows only' }, (t) => {
  for (const name of ['register-task.ps1', 'unregister-task.ps1', 'stop-receiver.ps1']) {
    const parsed = powershell(['-Command', `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(WINDOWS_DIR, name)}', [ref]$null, [ref]$errors); $errors.Count`]);
    assert.equal(parsed.stdout.trim(), '0', `${name}: ${parsed.stderr}`);
  }
  const imports = path.join(tempDir(t), 'imports');
  const taskName = 'Holdr Card Sync Definition Test';
  const result = powershell(['-File', path.join(WINDOWS_DIR, 'register-task.ps1'), '-DefinitionOnly', '-TaskName', taskName,
    '-NodePath', process.execPath, '-Imports', imports, '-Port', '4499']);
  assert.equal(result.status, 0, result.stderr);
  const xml = result.stdout;
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>[^<]+<\/UserId>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Command>[^<]*\\WindowsPowerShell\\v1\.0\\powershell\.exe<\/Command>/);
  const args = /<Arguments>([^<]*)<\/Arguments>/.exec(xml)[1].replace(/&amp;/g, '&');
  assert.match(args, /^-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "& '/);
  assert.ok(args.includes(`'${process.execPath}' '${path.join(REPO_ROOT, 'agents', 'card-sync', 'receiver.mjs')}'`));
  assert.ok(args.includes(`--imports '${imports}' --log-file '${path.join(imports, 'receiver.log')}'`));
  assert.ok(args.includes("--port 4499"));
  assert.ok(!args.includes('--data-dir') && !args.includes('--web-url'), 'without them the receiver picks its own defaults');
  assert.ok(xml.includes(`<WorkingDirectory>${REPO_ROOT}</WorkingDirectory>`));
  const registered = powershell(['-Command', `@(Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue).Count`]);
  assert.equal(registered.stdout.trim(), '0', 'a definition-only run registers nothing');
  // Given, Holdr's data folder and its HTTPS address are passed on.
  const dataDir = path.join(tempDir(t), 'holdr data');
  const tuned = powershell(['-File', path.join(WINDOWS_DIR, 'register-task.ps1'), '-DefinitionOnly', '-TaskName', taskName,
    '-NodePath', process.execPath, '-Imports', imports, '-DataDir', dataDir, '-WebUrl', 'https://holdr.example.test']);
  assert.equal(tuned.status, 0, tuned.stderr);
  const tunedArgs = /<Arguments>([^<]*)<\/Arguments>/.exec(tuned.stdout)[1].replace(/&amp;/g, '&');
  assert.ok(tunedArgs.includes(`--data-dir '${dataDir}' --web-url 'https://holdr.example.test'`), tunedArgs);
});

test('the Windows task hands node each folder exactly, whatever quotes its name holds and with a trailing backslash', { skip: !windows && 'Windows only' }, (t) => {
  // Windows PowerShell 5.1 also ends a single-quoted string at a typographic quote: without escaping, a folder named like
  // this one would run "exit 9" at every sign-in. A trailing backslash, as tab completion writes a folder, would make
  // PowerShell's double quotes for node escape themselves and run the arguments together.
  const base = path.join(tempDir(t), 'it\u2019s a \u2019;exit 9;\u2018 test');
  const imports = path.join(base, 'imports');
  const dataDir = path.join(base, 'holdr data');
  const definition = powershell(['-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; & $env:HOLDR_TEST_SCRIPT -DefinitionOnly '
    + "-TaskName 'Holdr Card Sync Quoting Test' -NodePath $env:HOLDR_TEST_NODE -Imports $env:HOLDR_TEST_IMPORTS -DataDir $env:HOLDR_TEST_DATA -Port 4499"], {
    HOLDR_TEST_SCRIPT: path.join(WINDOWS_DIR, 'register-task.ps1'), HOLDR_TEST_NODE: process.execPath,
    HOLDR_TEST_IMPORTS: `${imports}\\`, HOLDR_TEST_DATA: `${dataDir}\\`,
  });
  assert.equal(definition.status, 0, definition.stderr);
  const taskArgs = /<Arguments>([^<]*)<\/Arguments>/.exec(definition.stdout)[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  // The task's command line as Task Scheduler starts it (in no hidden window), with node printing the arguments it gets,
  // percent-encoded, in place of running the receiver.
  const receiver = `'${path.join(REPO_ROOT, 'agents', 'card-sync', 'receiver.mjs')}'`;
  assert.ok(taskArgs.includes(receiver), taskArgs);
  const echoing = taskArgs.replace(' -WindowStyle Hidden', '')
    .replace(receiver, "'-e' 'process.stdout.write(encodeURIComponent(JSON.stringify(process.argv.slice(1))))' '--'");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  const ran = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [echoing], {
    windowsVerbatimArguments: true, encoding: 'utf8', env, windowsHide: true, timeout: 120_000,
  });
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  assert.deepEqual(JSON.parse(decodeURIComponent(ran.stdout.trim())),
    ['--imports', imports, '--log-file', path.join(imports, 'receiver.log'), '--data-dir', dataDir, '--port', '4499']);
});

test('the macOS LaunchAgent runs the receiver at login and passes only the settings you give, leaving the rest to it', (t) => {
  const plain = printed([]);
  assert.equal(plain.status, 0, plain.err);
  assertPlist(t, plain.out);
  assert.deepEqual(plistStrings(plain.out), [
    LABEL, '/opt/sample/bin/node', '/Users/sample/src/holdr/agents/card-sync/receiver.mjs',
    '--log-file', '/Users/sample/Library/Logs/Holdr/card-sync-receiver.log',
    '/Users/sample/src/holdr', 'Background', '/Users/sample/Library/Logs/Holdr/card-sync-receiver-errors.log',
  ]);
  assert.doesNotMatch(plain.out, /--data-dir/, 'the receiver finds Holdr\'s data folder itself');
  assert.match(plain.out, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plain.out, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  // As for the receiver, an option wins over its environment variable; folders become absolute, since launchd starts
  // the receiver in the checkout.
  const env = { HOLDR_DATA_DIR: '~/holdr-data', HOLDR_WEB_URL: 'https://env.example.test' };
  const tuned = printed(['--web-url', 'https://holdr.example.test', '--imports', '../private/imports', '--port', '4402'], { env });
  assert.equal(tuned.status, 0, tuned.err);
  assert.deepEqual(plistStrings(tuned.out).slice(3, 13), [
    '--log-file', '/Users/sample/Library/Logs/Holdr/card-sync-receiver.log', '--port', '4402', '--web-url', 'https://holdr.example.test',
    '--data-dir', '/Users/sample/holdr-data', '--imports', '/Users/sample/src/private/imports',
  ]);
});

test('render-plist escapes every value for XML, and refuses what a LaunchAgent cannot hold', (t) => {
  const odd = { node: '/opt/a&b/<node>', repo: `/Users/sample/src/it's "holdr" | x`, logDir: '/Users/sample/Logs/R&D <x>', args: ['--owner-labels', "alex=Alex & Co,casey=Casey's"] };
  const xml = renderPlist(odd);
  assertPlist(t, xml);
  for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;']) assert.ok(xml.includes(entity), entity);
  const strings = plistStrings(xml);
  assert.deepEqual(strings.slice(1, 5), [odd.node, `${odd.repo}/agents/card-sync/receiver.mjs`, '--log-file', `${odd.logDir}/card-sync-receiver.log`]);
  assert.ok(strings.includes(odd.args[1]) && strings.includes(odd.repo));
  // From the script's own options, end to end.
  const imports = `/Users/sample/R&D <x> "it's" | y/imports`;
  const run = printed(['--imports', imports]);
  assert.equal(run.status, 0, run.err);
  assertPlist(t, run.out);
  assert.ok(plistStrings(run.out).includes(imports));
  for (const bad of ['/Users/sample/line\nbreak', '/Users/sample/bell\u0007', '/Users/sample/\ud800']) assert.throws(() => xmlText(bad), RenderError);
  assert.throws(() => renderPlist({ ...odd, node: '/opt/sample/bin/node\r' }), /control character/);
  assert.equal(printed(['--imports', '/Users/sample/line\nbreak']).status, 2);
});

test('render-plist checks the settings as the receiver will, and never echoes a value', () => {
  const web = printed(['--web-url', 'ftp://holdr.example.test/secret-value']);
  assert.equal(web.status, 2);
  assert.match(web.err, /--web-url must be an http:\/\/ address on this computer or an https:\/\/ address/);
  assert.equal(web.err.includes('secret-value'), false);
  assert.match(printed(['--imports', '/Users/sample/src/holdr/imports']).err, /must be outside the repository checkout/);
  assert.match(printed(['--log-dir', '/Users/sample/src/holdr/logs']).err, /--log-dir must be outside the repository checkout/);
  // A Mac's disk ignores letter case: these are the same folders.
  assert.match(printed(['--imports', '/users/sample/SRC/Holdr/imports']).err, /must be outside the repository checkout/);
  assert.match(printed(['--log-dir', '/Users/Sample/src/HOLDR/logs']).err, /--log-dir must be outside the repository checkout/);
  assert.match(printed(['--log-file', '/Users/sample/x.log']).err, /choose the folder with --log-dir/);
  assert.match(printed(['--bogus']).err, /unknown option --bogus/);
  assert.match(printed(['--port']).err, /--port needs a value/);
  assert.match(printed(['--help']).out, /^Writes the LaunchAgent[\s\S]*--web-url[\s\S]*--data-dir/);
});

test('render-plist creates the log folder owner-only and writes the LaunchAgent 0644, checked before it replaces the old one', (t) => {
  const root = tempDir(t);
  const out = path.join(root, 'LaunchAgents', `${LABEL}.plist`);
  const logDir = path.join(root, 'Logs', 'Holdr');
  const linted = [];
  installPlist({ out, xml: '<plist/>', logDir, lint: (file) => linted.push([file, fs.readFileSync(file, 'utf8')]) });
  assert.equal(fs.readFileSync(out, 'utf8'), '<plist/>');
  assert.ok(fs.statSync(logDir).isDirectory(), 'launchd opens the error log there before the receiver runs');
  assert.equal(linted.length, 1);
  assert.notEqual(linted[0][0], out, 'checked before it is put in place');
  assert.equal(linted[0][1], '<plist/>');
  if (!windows) {
    assert.equal(fs.statSync(out).mode & 0o777, 0o644);
    assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
  }
  // A file plutil refuses never replaces the one in place, and leaves nothing behind.
  assert.throws(() => installPlist({ out, xml: 'broken', logDir, lint: () => { throw new RenderError('plutil -lint did not accept it'); } }), /plutil/);
  assert.equal(fs.readFileSync(out, 'utf8'), '<plist/>');
  assert.deepEqual(fs.readdirSync(path.dirname(out)), [`${LABEL}.plist`]);
  // The folder created is the one StandardErrorPath names.
  const plan = planLaunchAgent({ ...MAC, argv: [] });
  assert.equal(path.posix.dirname(/<key>StandardErrorPath<\/key>\s*<string>([^<]+)<\/string>/.exec(plan.xml)[1]), plan.logDir);
  // On Windows it only prints.
  let err = '';
  assert.equal(renderMain([], { ...MAC, env: {}, platform: 'win32', stdout: { write() {} }, stderr: { write: (text) => { err += text; } } }), 2);
  assert.match(err, /run it on the Mac/);
});

test('render-plist, run on a Mac, writes the LaunchAgent and its log folder and says how to load it', { skip: windows && 'macOS and Linux only' }, (t) => {
  const home = path.join(tempDir(t), 'home');
  fs.mkdirSync(home);
  let said = '';
  const io = { stdout: { write: (text) => { said += text; } }, stderr: { write: (text) => { said += text; } } };
  assert.equal(renderMain(['--node', process.execPath], { env: {}, cwd: REPO_ROOT, homedir: home, ...io }), 0, said);
  const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  assert.equal(fs.statSync(plist).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(home, 'Library', 'Logs', 'Holdr')).mode & 0o777, 0o700);
  assertPlist(t, fs.readFileSync(plist, 'utf8'));
  assert.match(said, /launchctl bootout gui\/\$\(id -u\)\/local\.holdr\.card-sync 2>\/dev\/null\n {2}launchctl bootstrap gui\/\$\(id -u\) '/);
});

test('the macOS guide unloads an older LaunchAgent, writes it with the script, then loads it; uninstall removes the file', () => {
  const block = /```zsh\n([\s\S]*?)```/.exec(guideSection('### macOS: a LaunchAgent'))[1];
  const bootout = at(block, /^launchctl bootout gui\/\$\(id -u\)\/local\.holdr\.card-sync 2>\/dev\/null$/m);
  const render = at(block, /^node agents\/card-sync\/install\/macos\/render-plist\.mjs$/m);
  const bootstrap = at(block, /^launchctl bootstrap gui\/\$\(id -u\) ~\/Library\/LaunchAgents\/local\.holdr\.card-sync\.plist$/m);
  assert.ok(bootout < render && render < bootstrap, 'running the commands again replaces a loaded LaunchAgent');
  assert.doesNotMatch(read(DOCS), /\bsed\b|plist\.template/, 'no hand-made substitutions');
  const uninstall = guideSection('## Uninstall');
  assert.ok(at(uninstall, /^\s*launchctl bootout gui\/\$\(id -u\)\/local\.holdr\.card-sync/m)
    < at(uninstall, /^\s*rm -f ~\/Library\/LaunchAgents\/local\.holdr\.card-sync\.plist/m));
});

test('the guide stops the Windows receiver itself before an update, and starts the updated one', () => {
  const update = guideSection('## Update');
  assert.match(update, /agents\\card-sync\\install\\windows\\stop-receiver\.ps1/);
  for (const line of update.split('\n').filter((entry) => entry.includes('Stop-ScheduledTask'))) {
    assert.match(line, /Stop-ScheduledTask` alone leaves the receiver running/, 'never offered as the way to stop it');
  }
  assert.match(update, /run `register-task\.ps1` again/);
  assert.ok(at(update, /launchctl bootout/) < at(update, /launchctl bootstrap/));
  const uninstall = guideSection('## Uninstall');
  assert.match(uninstall, /unregister-task\.ps1/);
  assert.match(uninstall, /card-sync-receiver-errors\.log/, 'the macOS logs are removed too');
});
