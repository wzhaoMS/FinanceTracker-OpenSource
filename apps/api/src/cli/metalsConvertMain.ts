import { runMetalsConvertCli } from './metalsConvert.js';

process.exitCode = await runMetalsConvertCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
