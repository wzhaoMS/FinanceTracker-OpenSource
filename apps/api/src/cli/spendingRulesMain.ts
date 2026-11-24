import { runSpendingRulesCli } from './spendingRules.js';

process.exitCode = await runSpendingRulesCli(process.argv.slice(2), { env: process.env, io: process });
