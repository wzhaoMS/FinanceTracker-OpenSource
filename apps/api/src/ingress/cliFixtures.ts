import fs from 'node:fs';
import path from 'node:path';

export function fakeTailscale(root: string) {
  const cli = path.join(root, 'tailscale');
  const config = path.join(root, 'cli.json');
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const input = JSON.parse(fs.readFileSync(path.join(root, 'cli.json'), 'utf8'));
fs.appendFileSync(path.join(root, 'calls'), process.argv.slice(2).join(' ') + '\\n');
if (input.mode === 'exit') process.exit(1);
if (input.mode === 'hang') setInterval(() => {}, 1000);
else if (input.mode === 'big') process.stdout.write('x'.repeat(2 * 1024 * 1024));
else if (input.mode === 'garbage') process.stdout.write('not JSON');
else if (input.mode === 'env') process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));
else if (input.mode === 'pipe') {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},2000)'], {stdio:['ignore',1,2]});
  fs.writeFileSync(path.join(root, 'grandchild'), String(child.pid));
  process.exit(0);
} else process.stdout.write(input[process.argv[2]] ?? '{}\\n');
`, { mode: 0o700, flag: 'wx' });
  const set = (input: Record<string, unknown>) => fs.writeFileSync(config, JSON.stringify(input), { mode: 0o600 });
  set({});
  return { cli, set };
}
