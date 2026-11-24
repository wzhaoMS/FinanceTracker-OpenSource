import { runRetailConvertCli } from './retailConvert.js';

process.exitCode = await runRetailConvertCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
