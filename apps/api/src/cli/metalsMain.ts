import { runMetalsCli } from './metals.js';

process.exitCode = await runMetalsCli(process.argv.slice(2), { env: process.env, io: process });
