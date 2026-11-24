import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LSOF, POWERSHELL, checkListener, findListeners, parseLsof, parseProcNetTcp, parseWindowsListeners, windowsListenerScript,
} from '../lib/listener.mjs';

// Synthetic SIDs and user ids only.
const ME = 'S-1-5-21-111111111-222222222-333333333-1001';
const OTHER = 'S-1-5-21-111111111-222222222-333333333-1002';

/** A `run` for findListeners that answers like the program would, and records what was run. */
function runner(answer) {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    return answer;
  };
  return { run, calls };
}

test('Windows: each listener\'s owner SID is compared with this account\'s; an unreadable owner is not taken for this account', async () => {
  const json = (listeners) => JSON.stringify({ me: ME, listeners });
  assert.deepEqual(parseWindowsListeners(json([{ pid: 10, sid: ME }])), [{ pid: 10, mine: true }]);
  assert.deepEqual(parseWindowsListeners(json([{ pid: 10, sid: ME }, { pid: 11, sid: OTHER }, { pid: 12, sid: null }])),
    [{ pid: 10, mine: true }, { pid: 11, mine: false }, { pid: 12, mine: null }]);
  // PowerShell 5.1 may write a single listener as an object rather than a one-element array.
  assert.deepEqual(parseWindowsListeners(JSON.stringify({ me: ME, listeners: { pid: 10, sid: ME } })), [{ pid: 10, mine: true }]);
  assert.deepEqual(parseWindowsListeners(`${json([])}\r\n`), []);
  for (const bad of ['', 'not json', JSON.stringify({ me: null, listeners: [] }), JSON.stringify({ me: 'alex', listeners: [] })]) {
    assert.throws(() => parseWindowsListeners(bad), { name: 'ListenerCheckError' }, bad);
  }

  const { run, calls } = runner({ code: 0, stdout: json([{ pid: 10, sid: ME }]) });
  const saved = process.env.PSModulePath;
  process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules';
  try {
    assert.deepEqual(await checkListener(4000, { platform: 'win32', run }), { state: 'yours', pids: [10] });
  } finally {
    if (saved === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = saved;
  }
  assert.ok(!Object.keys(calls[0].options.env).some((name) => name.toLowerCase() === 'psmodulepath'), 'PowerShell 7\'s module path is not passed on');
  assert.equal(calls[0].file, POWERSHELL());
  assert.match(calls[0].file, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  const encoded = calls[0].args[calls[0].args.indexOf('-EncodedCommand') + 1];
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.equal(script, windowsListenerScript(4000));
  assert.match(script, /Get-NetTCPConnection -State Listen -LocalPort 4000 /);
  assert.match(script, /GetOwnerSid/);
  assert.throws(() => windowsListenerScript('4000; Remove-Item x'), { name: 'ListenerCheckError' });

  assert.equal((await checkListener(4000, { platform: 'win32', run: runner({ code: 0, stdout: json([{ pid: 11, sid: OTHER }]) }).run })).state, 'other');
  assert.equal((await checkListener(4000, { platform: 'win32', run: runner({ code: 0, stdout: json([{ pid: 4, sid: null }]) }).run })).state, 'unknown');
  assert.deepEqual(await checkListener(4000, { platform: 'win32', run: runner({ code: 1, stdout: '' }).run }),
    { state: 'failed', reason: 'Windows PowerShell could not list the listening programs' });
});

test('macOS: lsof\'s user id for each listening process; nothing visible is "none", an lsof failure refuses', async () => {
  assert.deepEqual(parseLsof('p501\nu501\nf22\n', 501), [{ pid: 501, mine: true }]);
  assert.deepEqual(parseLsof('p700\nu502\nf9\np701\nu501\nf3\n', 501), [{ pid: 700, mine: false }, { pid: 701, mine: true }]);
  assert.deepEqual(parseLsof('p700\nf9\n', 501), [{ pid: 700, mine: null }]);

  const { run, calls } = runner({ code: 0, stdout: 'p900\nu501\nf22\n' });
  assert.deepEqual(await checkListener(4001, { platform: 'darwin', run, uid: 501 }), { state: 'yours', pids: [900] });
  assert.deepEqual(calls.map(({ file, args }) => ({ file, args })), [{ file: LSOF, args: ['-nP', '-iTCP:4001', '-sTCP:LISTEN', '-Fpu'] }]);
  assert.equal((await checkListener(4001, { platform: 'darwin', run: runner({ code: 0, stdout: 'p900\nu502\n' }).run, uid: 501 })).state, 'other');
  // lsof exits 1 with no output when it finds nothing; it shows another account's processes only to an administrator.
  assert.deepEqual(await checkListener(4001, { platform: 'darwin', run: runner({ code: 1, stdout: '' }).run, uid: 501 }), { state: 'none', pids: [] });
  assert.equal((await checkListener(4001, { platform: 'darwin', run: runner({ code: 1, stdout: 'lsof: odd\n' }).run, uid: 501 })).state, 'failed');
  const unavailable = async () => { throw Object.assign(new Error('spawn'), { name: 'ListenerCheckError', message: 'lsof could not run' }); };
  assert.equal((await checkListener(4001, { platform: 'darwin', run: unavailable, uid: 501 })).state, 'failed');
  assert.equal((await checkListener(4001, { platform: 'darwin', run, uid: undefined })).state, 'failed');
});

test('Linux: the user id of each listening socket on the port in /proc/net/tcp and tcp6', async () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const row = (local, state, uid) => `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 12345 1`;
  const tcp = [header, row('0100007F:0FA0', '0A', '1000'), row('0100007F:0FA1', '0A', '1001'), row('0100007F:0FA0', '01', '1001'), ''].join('\n');
  assert.deepEqual(parseProcNetTcp(tcp, 4000, 1000), [{ pid: null, mine: true }]);
  assert.deepEqual(parseProcNetTcp(tcp, 4001, 1000), [{ pid: null, mine: false }]);
  const tcp6 = [header, row('00000000000000000000000000000000:0FA0', '0A', '1001')].join('\n');
  const files = { '/proc/net/tcp': tcp, '/proc/net/tcp6': tcp6 };
  const readFile = async (file) => files[file];
  assert.deepEqual(await checkListener(4000, { platform: 'linux', readFile, uid: 1000 }), { state: 'other', pids: [] });
  const noSix = async (file) => {
    if (file.endsWith('6')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return tcp;
  };
  assert.deepEqual(await checkListener(4000, { platform: 'linux', readFile: noSix, uid: 1000 }), { state: 'yours', pids: [] });
  assert.deepEqual(await checkListener(4002, { platform: 'linux', readFile: noSix, uid: 1000 }), { state: 'none', pids: [] });
  const denied = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.equal((await checkListener(4000, { platform: 'linux', readFile: denied, uid: 1000 })).state, 'failed');
});

test('other systems and bad ports: the check cannot run, so nothing is sent', async () => {
  assert.deepEqual(await checkListener(4000, { platform: 'freebsd', uid: 1000 }), { state: 'failed', reason: 'this operating system is not supported' });
  for (const port of [0, 65536, 4000.5, '4000']) {
    await assert.rejects(findListeners(port, { platform: 'darwin', uid: 501, run: runner({ code: 0, stdout: '' }).run }), { name: 'ListenerCheckError' });
  }
});
