// Removes the given paths, recursively and without complaint when they are absent: `rm -rf` for npm scripts on Windows,
// macOS and Linux alike.
import fs from 'node:fs';

for (const target of process.argv.slice(2)) fs.rmSync(target, { recursive: true, force: true });
