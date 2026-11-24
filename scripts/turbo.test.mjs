import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/turbo.mjs: Turborepo runs with its telemetry off, and every root script that runs turbo goes through it.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every root script that runs turbo runs it through scripts/turbo.mjs', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const throughWrapper = Object.entries(scripts).filter(([, command]) => command.includes('node scripts/turbo.mjs '));
  assert.ok(throughWrapper.length >= 5, 'build, dev, lint, test and typecheck run turbo');
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(command, /(^|[;&|]\s*|\bnpx\s+)turbo\b/, `${name} runs turbo directly`);
  }
});

test('turbo run through the wrapper reports its telemetry as disabled', () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(TURBO_TELEMETRY_DISABLED|DO_NOT_TRACK)$/i.test(name)) delete env[name];
  const result = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'turbo.mjs'), 'telemetry', 'status'], {
    cwd: REPO, env, encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status:\s*Disabled/);
});
