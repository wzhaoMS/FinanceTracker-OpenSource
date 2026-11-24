import { runCardKindCorrectionsCli } from './cardKindCorrections.js';

process.exitCode = await runCardKindCorrectionsCli(process.argv.slice(2), { env: process.env, io: process });
