import { runCardOpeningsCli } from './cardOpenings.js';

process.exitCode = await runCardOpeningsCli(process.argv.slice(2), { env: process.env, io: process });
