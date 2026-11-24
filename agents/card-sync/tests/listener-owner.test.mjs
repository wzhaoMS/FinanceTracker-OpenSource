// Who runs the program on Holdr's port, as each system reports it: the lookups are replaced by synthetic answers here (the
// real one runs in holdr-api.test.mjs and, through the receiver itself, in cli.test.mjs).
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { listenerOwner, parseNetstat } from '../lib/listener-owner.mjs';

const ME = 'S-1-5-21-1000-2000-3000-1001';
const OTHER = 'S-1-5-21-1000-2000-3000-1002';
// netstat -ano as Windows prints it, the state column translated (German, Spanish) on some lines.
const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1104',
  '  TCP    127.0.0.1:4000         0.0.0.0:0              LISTENING       5120',
  '  TCP    127.0.0.1:4000         127.0.0.1:53211        ESTABLISHED     5120',
  '  TCP    127.0.0.1:53211        127.0.0.1:4000         ESTABLISHED     7300',
  '  TCP    [::]:4000              [::]:0                 ABHÖREN         6400',
  '  TCP    [::1]:4000             [::]:0                 LISTENING       6500',
  '  TCP    192.0.2.7:4000         0.0.0.0:0              EN ESCUCHA      6600',
  '  UDP    0.0.0.0:4000           *:*                                    6700',
].join('\r\n');

/** netstat and Windows PowerShell as Windows answers them: `owners` maps a process ID to its owner's SID (or null). */
function fakeWindows(netstat, owners, { wrap = false } = {}) {
  const asked = [];
  const run = async (file, args, options = {}) => {
    const program = path.win32.basename(file).toLowerCase();
    if (program === 'netstat.exe') return netstat;
    assert.equal(program, 'powershell.exe');
    const pids = options.env.CARD_SYNC_PIDS.split(',').map(Number);
    asked.push(pids);
    const list = pids.map((pid) => ({ pid, sid: owners[pid] ?? null }));
    return JSON.stringify({ me: ME, owners: wrap ? { value: list, Count: list.length } : list });
  };
  return { run, asked };
}

test('Windows: netstat\'s listening sockets on the port, read without its translated state column', () => {
  assert.deepEqual(parseNetstat(NETSTAT, 4000), [
    { address: '127.0.0.1', pid: 5120 }, { address: '::', pid: 6400 }, { address: '::1', pid: 6500 }, { address: '192.0.2.7', pid: 6600 },
  ]);
});

test('Windows: yours only when every listener a 127.0.0.1 connection can reach belongs to this account', async () => {
  const both = fakeWindows(NETSTAT, { 5120: ME, 6400: ME });
  assert.deepEqual(await listenerOwner(4000, { platform: 'win32', run: both.run }), { owner: 'you' });
  assert.deepEqual(both.asked, [[5120, 6400]], 'only the owners of 127.0.0.1 and the wildcards are asked for');
  assert.deepEqual(await listenerOwner(4000, { platform: 'win32', run: fakeWindows(NETSTAT, { 5120: ME, 6400: OTHER }).run }), { owner: 'other' });
  assert.deepEqual(await listenerOwner(4000, { platform: 'win32', run: fakeWindows(NETSTAT, { 5120: ME }, { wrap: true }).run }), { owner: 'unknown', why: 'unreadable' },
    'an owner Windows does not tell (another account\'s process) is not confirmed');
  const loopbackOnly = NETSTAT.split('\r\n').filter((line) => !line.includes('[::]:4000')).join('\r\n');
  assert.deepEqual(await listenerOwner(4000, { platform: 'win32', run: fakeWindows(loopbackOnly, { 5120: ME }, { wrap: true }).run }), { owner: 'you' });
  const nothing = fakeWindows(NETSTAT.replaceAll(':4000 ', ':4001 '), {});
  assert.deepEqual(await listenerOwner(4000, { platform: 'win32', run: nothing.run }), { owner: 'unknown', why: 'hidden' });
  assert.deepEqual(nothing.asked, [], 'no listener, so no owner to ask for');
  assert.deepEqual(await listenerOwner(4000, { platform: 'win32', run: async () => { throw new Error('netstat failed'); } }), { owner: 'unknown', why: 'failed' });
});

test('macOS: lsof\'s listeners and their user IDs; lsof shows only this account\'s, so another account\'s is never yours', async () => {
  const lsof = (output, status = 0) => async (file, args) => {
    assert.deepEqual([file, ...args], ['/usr/sbin/lsof', '-nP', '-iTCP:4000', '-sTCP:LISTEN', '-Fpun']);
    if (status !== 0) throw Object.assign(new Error('lsof exited'), { code: status, stdout: output });
    return output;
  };
  const mac = (run) => ({ platform: 'darwin', uid: 501, run });
  assert.deepEqual(await listenerOwner(4000, mac(lsof('p812\nu501\nf23\nn127.0.0.1:4000\n'))), { owner: 'you' });
  assert.deepEqual(await listenerOwner(4000, mac(lsof('p812\nu502\nf23\nn127.0.0.1:4000\n'))), { owner: 'other' });
  assert.deepEqual(await listenerOwner(4000, mac(lsof('', 1))), { owner: 'unknown', why: 'hidden' }, 'lsof found nothing it may show');
  assert.deepEqual(await listenerOwner(4000, mac(lsof('p812\nu501\nf23\nn*:4000\n'))), { owner: 'unknown', why: 'hidden' }, 'not on 127.0.0.1, where Holdr listens');
  assert.deepEqual(await listenerOwner(4000, mac(lsof('p812\nu501\nf23\nn127.0.0.1:4000\np900\nu501\nf9\nn[::1]:4000\n', 1))), { owner: 'you' });
});

test('Linux: /proc/net/tcp and tcp6 list every listener with its owner\'s user ID', async () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const tables = {
    '/proc/net/tcp': `${header}   0: 0100007F:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1\n`
      + '   1: 0100007F:0FA0 0100007F:D3A3 01 00000000:00000000 00:00000000 00000000  1001        0 12346 1\n',
    '/proc/net/tcp6': `${header}   0: 00000000000000000000000000000000:0FA0 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 22 1\n`,
  };
  const linux = (uid, files) => ({ platform: 'linux', uid, readFile: async (file) => files[file] ?? '' });
  assert.deepEqual(await listenerOwner(4000, linux(1000, { '/proc/net/tcp': tables['/proc/net/tcp'] })), { owner: 'you' });
  assert.deepEqual(await listenerOwner(4000, linux(1001, { '/proc/net/tcp': tables['/proc/net/tcp'] })), { owner: 'other' });
  assert.deepEqual(await listenerOwner(4000, linux(1000, tables)), { owner: 'other' }, 'another account listens on [::]:4000 too');
  assert.deepEqual(await listenerOwner(4001, linux(1000, tables)), { owner: 'unknown', why: 'hidden' });
});
