import { runAmazonCli } from './amazon.js';

process.exitCode = await runAmazonCli(process.argv.slice(2), { env: process.env, io: process });
