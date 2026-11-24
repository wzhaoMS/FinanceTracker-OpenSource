import path from 'node:path';
import { parseArgs } from 'node:util';
import { verifyRelease } from '@finance-tracker/shared/web-release/files';
import { WebReleaseError } from '@finance-tracker/shared/web-release';

try {
  const { values } = parseArgs({ options: { dir: { type: 'string' }, digest: { type: 'string' } }, strict: true });
  if (!values.dir || !values.digest) throw new WebReleaseError('E0I_RELEASE_CONFIG');
  const release = verifyRelease(path.resolve(values.dir), values.digest);
  const bytes = release.manifest.files.reduce((sum, file) => sum + file.size, 0);
  console.log(`VERIFIED digest=${release.digest} files=${release.manifest.files.length} bytes=${bytes}`);
} catch (error) {
  console.error(error instanceof WebReleaseError ? error.code : 'E0I_RELEASE_PATH');
  process.exitCode = 1;
}
