import { runCheckingConvertCli } from './checkingConvert.js';

process.exitCode = await runCheckingConvertCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
