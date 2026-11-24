import { runAmazonImagesCli } from './amazonImages.js';

process.exitCode = await runAmazonImagesCli(process.argv.slice(2), { env: process.env, io: process });
