import { parseArgs } from 'node:util';
import path from 'node:path';
import { verifyNativeHelper } from '../src/ingress/nativeHelper.js';

try {
  const { values } = parseArgs({
    options: { commit: { type: 'string' }, digest: { type: 'string' }, dir: { type: 'string' } }, strict: true,
  });
  if (!values.commit || !values.digest) throw Error('reviewed commit and artifact pin required');
  const result = verifyNativeHelper({
    sourceCommit: values.commit, manifestDigest: values.digest, buildDir: values.dir ? path.resolve(values.dir) : undefined,
  });
  console.log(`VERIFIED_NATIVE commit=${result.manifest.sourceCommit} manifest=${result.manifestDigest} binary=${result.manifest.binary.sha256}`);
} catch {
  console.error('E0I_NATIVE_HELPER');
  process.exitCode = 1;
}
