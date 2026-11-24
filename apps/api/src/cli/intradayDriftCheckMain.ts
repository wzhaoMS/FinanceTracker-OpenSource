import { runIntradayDriftCheck } from './intradayDriftCheck.js';

process.exitCode = await runIntradayDriftCheck(process.argv.slice(2), { env: process.env, io: process });
