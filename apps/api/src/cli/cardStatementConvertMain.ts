import { runCardStatementConvertCli } from './cardStatementConvert.js';

process.exitCode = await runCardStatementConvertCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
