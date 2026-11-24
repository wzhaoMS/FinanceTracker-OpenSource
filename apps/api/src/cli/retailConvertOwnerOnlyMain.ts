import { runRetailConvertOwnerOnlyCli } from './retailConvertOwnerOnly.js';

process.exitCode = runRetailConvertOwnerOnlyCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
