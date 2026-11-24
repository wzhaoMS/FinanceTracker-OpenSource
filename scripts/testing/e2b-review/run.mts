import { spawnSync } from 'node:child_process';
import { fs, path, HERE, TREE, LOADER, REPORT_DIR } from './probe-common.mts';

if (process.platform !== 'darwin') throw new Error('E2b interprocess regressions require macOS lifecycle locks');
for (const script of ['protocol-probes.mts', 'http-probes.mts', 'dev-startup-probe.mts', 'rotation-probe.mts']) {
  const result = spawnSync(process.execPath, ['--import', LOADER, path.join(HERE, script)], {
    cwd: TREE, env: process.env, encoding: 'utf8', timeout: 300_000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`E2b regression failed: ${script}`);
}
const rows = ['protocol-results.json', 'http-results.json', 'dev-startup-results.json', 'rotation-results.json']
  .flatMap((file) => JSON.parse(fs.readFileSync(path.join(REPORT_DIR, file), 'utf8')));
if (rows.length !== 25 || rows.some((row) => row.pass !== true)) throw new Error('E2b review regression catalog incomplete');
console.log('E2b review regressions: 25 passed, including all nine SIGKILL checkpoints');
