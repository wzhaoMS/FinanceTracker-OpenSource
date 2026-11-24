import { runPaymentReconciliationCli } from './paymentReconciliation.js';

process.exitCode = await runPaymentReconciliationCli(process.argv.slice(2), { env: process.env, io: process });
