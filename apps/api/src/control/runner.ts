import type { CommandResult } from '../ingress/boundedCommand.js';

/**
 * How control code runs a local tool (`ioreg`, `diskutil`, `df`, `lsof`, `tmutil`). Modules that lease-accepting roles
 * import receive a runner instead of importing `node:child_process`, so a leased role can only start children through
 * `spawnLeased` (§9.3 lease-aware path; enforced by `leaseLint.test.ts`).
 */
export type Runner = (file: string, args: readonly string[]) => Promise<CommandResult>;
