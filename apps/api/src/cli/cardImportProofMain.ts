import { runCardImportProofCli } from './cardImportProof.js';

process.exitCode = await runCardImportProofCli(process.argv.slice(2), { env: process.env, io: process });
