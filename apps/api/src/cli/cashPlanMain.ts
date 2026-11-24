import { runCashPlanCli } from './cashPlan.js';

process.exitCode = await runCashPlanCli(process.argv.slice(2), { env: process.env, io: process });
