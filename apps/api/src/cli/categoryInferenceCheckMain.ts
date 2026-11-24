import { runCategoryInferenceCheck } from './categoryInferenceCheck.js';

process.exitCode = await runCategoryInferenceCheck(process.argv.slice(2), { env: process.env, io: process });
