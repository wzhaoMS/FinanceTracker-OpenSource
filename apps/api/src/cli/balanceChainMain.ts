import { runBalanceChainCli } from './balanceChain.js';

process.exitCode = await runBalanceChainCli(process.argv.slice(2), { env: process.env, io: process });
