import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(api, 'dist', 'release');
mkdirSync(target, { recursive: true });
copyFileSync(path.join(api, 'src', 'release', 'codeIdentity.mjs'), path.join(target, 'codeIdentity.mjs'));
