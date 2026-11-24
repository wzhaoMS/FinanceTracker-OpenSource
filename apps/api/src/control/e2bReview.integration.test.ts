import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './paths.js';

describe.skipIf(process.platform !== 'darwin')('E2b r1 real-process review regressions', () => {
  it('passes all 25 reviewer scenarios, including nine actual SIGKILL checkpoints', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/testing/e2b-review/run.mts'], {
      cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (bytes) => { output += bytes.toString(); });
    child.stderr.on('data', (bytes) => { output += bytes.toString(); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(exit, output).toBe(0);
    expect(output).toContain('25 passed, including all nine SIGKILL checkpoints');
  }, 600_000);
});
