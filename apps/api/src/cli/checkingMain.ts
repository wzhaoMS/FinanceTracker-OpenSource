import { runCheckingCli } from './checking.js';

process.exitCode = await runCheckingCli(process.argv.slice(2), { env: process.env, io: process });
