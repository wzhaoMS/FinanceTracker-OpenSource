// The start script's configuration (design §8.1, §8.2 steps 3-4): see apps/api/src/control/startConfig.ts.
import { runStartConfig } from '../../apps/api/src/control/startConfig.js';

process.exitCode = runStartConfig(process.argv.slice(2), process.env, process);
