import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { withTestTools } from './start-finance-mac.fixture.mjs';

for (const name of [
  'start-finance-mac.sh', 'holdr-leased.sh', 'rollback-kit.sh',
  'deploy-apply.sh', 'holdr-stop.sh', 'holdr-publish-legacy.sh',
]) {
  test(`${name} accepts an installed absolute Node runtime and fails closed otherwise`, () => {
    const source = fs.readFileSync(new URL(name, import.meta.url), 'utf8');
    const originalLines = source.split(/\r?\n/);
    assert.equal(originalLines.filter((line) => line === 'NODE="${HOLDR_NODE:-$(command -v node || true)}"').length, 1);
    assert.match(source, /[Ss]et HOLDR_NODE|HOLDR_NODE is not executable|Node was not found/);
    const testNode = '/synthetic/runtime/bin/node';
    const rewritten = withTestTools(source, { node: testNode });
    const changed = rewritten.split(/\r?\n/).filter((line, index) => line !== originalLines[index]);
    assert.equal(changed.length, 1);
    assert.equal(changed[0], `NODE='${testNode}'`);
  });
}
