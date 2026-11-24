import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectProducts } from '../services/amazon/products.js';
import { assertPrivate, readPrivateJson, writePrivateJson } from '../services/amazon/privateFiles.js';
import { makeAgentReview } from '../services/amazon/categorization.js';
import { refuse } from '../services/amazon/policy.js';
import type { Io } from './controlCommon.js';

export function runAmazonProducts(args: string[], io: Io): number {
  try {
    const [command, ...rest] = args;
    const opts = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      if (!rest[i].startsWith('--') || !rest[i + 1] || opts.has(rest[i]) || !path.isAbsolute(rest[i + 1])) return refuse();
      opts.set(rest[i], rest[i + 1]);
    }
    const expected = command === 'extract' ? ['--staging', '--output']
      : command === 'mapping' ? ['--products', '--categories', '--assignments', '--output'] : [];
    if (!expected.length || opts.size !== expected.length || expected.some(k => !opts.has(k))) return refuse();
    const output = opts.get('--output')!;
    if (command === 'extract') {
      const dir = opts.get('--staging')!;
      assertPrivate(dir);
      const files = fs.readdirSync(dir, { withFileTypes: true }).filter(f => f.name.endsWith('.json'));
      if (files.length > 1000 || files.some(f => !f.isFile())) return refuse();
      const inputs = files.map(f => readPrivateJson(path.join(dir, f.name)));
      const result = projectProducts(inputs);
      writePrivateJson(output, result);
      io.stdout.write(JSON.stringify({ code: 'titles-extracted', version: result.version, captures: inputs.length,
        products: result.products.length, coverage: result.coverage }) + '\n');
    } else {
      const review = makeAgentReview(readPrivateJson(opts.get('--products')!), readPrivateJson(opts.get('--categories')!),
        readPrivateJson(opts.get('--assignments')!));
      writePrivateJson(output, review);
      io.stdout.write(JSON.stringify({ code: 'private-mapping-written-not-applied', classified: review.entries.length }) + '\n');
    }
    return 0;
  } catch {
    io.stderr.write('amazon-products: operation-refused\n');
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runAmazonProducts(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
}
