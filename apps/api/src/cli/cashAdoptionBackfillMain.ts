import { runCashAdoptionBackfill } from './cashAdoptionBackfill.js';

process.exitCode = await runCashAdoptionBackfill(process.argv.slice(2), { env: process.env, io: process });
