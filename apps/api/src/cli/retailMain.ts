import { runRetailCli } from './retail.js';

process.exitCode = await runRetailCli(process.argv.slice(2), { env: process.env, io: process });
