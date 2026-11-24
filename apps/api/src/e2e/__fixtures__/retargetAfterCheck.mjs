// Test fixture for runIdentity.test.ts, preloaded into the API with --import.
// It plays another user who controls a writable directory on the way to
// HOLDR_DATA_DIR. When the API logs that the run identity is enabled (after
// it has checked the data directory, before it migrates or opens anything),
// the symlink E2E_TEST_RETARGET_LINK is pointed at E2E_TEST_RETARGET_TO.
import fs from 'node:fs';

const link = process.env.E2E_TEST_RETARGET_LINK;
const target = process.env.E2E_TEST_RETARGET_TO;

if (link && target) {
  const log = console.log;
  console.log = (...args) => {
    if (String(args[0]).includes('e2e run identity enabled')) {
      fs.unlinkSync(link);
      // A junction on Windows, which any user may create there; a symlink elsewhere.
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      log(`[test] retargeted ${link} -> ${target} after the check`);
    }
    return log(...args);
  };
}
