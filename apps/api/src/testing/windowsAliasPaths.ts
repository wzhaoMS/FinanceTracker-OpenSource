import path from 'node:path';

/**
 * Synthetic output paths for ROOT's name rule (`isWindowsAliasName`, cli/ownerOnlyOutput.ts, 11/09): every form it
 * refuses, and ordinary names beside them that it must leave alone. The module's tests and operatorIo's hold every form
 * to it from this one list.
 */

/** Every device name the rule refuses, as ROOT's list writes it: COM and LPT with 0 to 9, and with ¹, ² and ³. */
export const WINDOWS_DEVICE_NAMES: readonly string[] = ['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
  ...['COM', 'LPT'].flatMap((port) => [...Array.from({ length: 10 }, (_, digit) => String(digit)), '\u00B9', '\u00B2', '\u00B3']
    .map((digit) => `${port}${digit}`))];

/**
 * Folder names Node makes as given, which Win32 reads as `run`: `run.` anywhere on a path (it trims a folder's trailing
 * dot), and `run ` only as a path's last name (#318's probe and ours: SQLite can't open `run \x`, and the ACL reader
 * reads the folder `run ` itself as `run`, but a file in it as that file). The rule refuses both, wherever they are; a
 * test makes them, and aims paths into them.
 */
export const ALIAS_FOLDERS: readonly string[] = ['run.', 'run '];

const mixedCase = (name: string) => [...name].map((char, index) => (index % 2 === 0 ? char.toLowerCase() : char.toUpperCase())).join('');

/**
 * Each name the rule refuses: ending in a dot or a space; holding a colon (a stream, or a drive's form inside a path);
 * and each device name as written, in lower and in mixed case, with one or two extensions, and with a space before one.
 */
const ALIAS_NAMES: readonly string[] = [
  'new.json.', 'new.json ', 'new.json..', 'new.json .', 'new.json. ',
  'new.json:stream', 'new.json::$DATA', 'C:new.json', ':new.json',
  ...WINDOWS_DEVICE_NAMES.flatMap((device) => [device, device.toLowerCase(), mixedCase(device), `${device}.json`,
    `${mixedCase(device)}.tar.gz`, `${device.toLowerCase()} .txt`]),
];

/**
 * Every form of output path the rule refuses, under `dir`, a test's own folder with ALIAS_FOLDERS made in it: each
 * alias name as the file's name and as a folder's on the way to it, a file in each alias folder (and deeper in it), an
 * ordinary path behind each namespace prefix, `\\?\`, `\\.\` and `\??\`, with either separator, and a share behind
 * `/??/`. A write that the rule let through would land in `dir`, or fail for want of a folder. A share behind `\??\`
 * (ROOT's O84 case) has a Windows-only test of its own: on POSIX it is one relative name, which such a write would make
 * in the working folder.
 */
export function windowsAliasPaths(dir: string): string[] {
  return [
    ...ALIAS_NAMES.map((name) => path.join(dir, name)),
    ...ALIAS_NAMES.map((name) => path.join(dir, name, 'new.json')),
    ...ALIAS_FOLDERS.flatMap((folder) => [path.join(dir, folder, 'new.json'), path.join(dir, folder, 'deeper', 'new.json')]),
    ...['\\\\?\\', '\\\\.\\', '\\??\\', '//?/', '//./', '/??/'].map((prefix) => `${prefix}${path.join(dir, 'new.json')}`),
    '/??/UNC/server/share/new.json',
  ];
}

/** File names the rule leaves alone, each close to one it refuses. */
export const ORDINARY_NAMES: readonly string[] = ['new.json', 'console.json', 'nul-report.json', 'com10.json', 'lpt.json',
  'conin.json', 'auxiliary', 'run.d', '.new', 'new.d.json'];
