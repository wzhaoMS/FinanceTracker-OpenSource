import { configuredControlDir, controlDirFor } from '../control/controlDir.js';
import { ControlError, describeError, exitCodeOf } from '../control/errors.js';
import { existingAncestor } from '../control/files.js';
import { loadConfiguration, type Configuration } from '../control/holdrConf.js';
import { computeMachineId } from '../control/machineId.js';
import { isCanonicalNativeAbsolute, repoPaths } from '../control/paths.js';
import type { Runner } from '../control/runner.js';

export interface Io {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

/** Configuration every control CLI shares: holdr.conf merged (§7.1), the control dir, the data dir. */
export interface ControlContext {
  readonly config: Configuration;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** Resolved when read: commands that need no control dir (a Windows backup) never require HOME. */
  readonly controlDir: string;
  readonly controlDirConfigured: boolean;
  readonly dataDir: string;
}

export function controlContext(rawEnv: NodeJS.ProcessEnv): ControlContext {
  const config = loadConfiguration(rawEnv);
  const env = config.env;
  const dataSetting = env.HOLDR_DATA_DIR?.trim();
  if (dataSetting !== undefined && dataSetting !== '' && !isCanonicalNativeAbsolute(dataSetting)) {
    throw new ControlError('E0I_DATA_DIR_UNSET', 1, 'HOLDR_DATA_DIR must be an absolute path');
  }
  const controlDirConfigured = configuredControlDir(env) !== null;
  return Object.freeze({
    config, env, controlDirConfigured,
    get controlDir() { return controlDirFor(env); },
    dataDir: dataSetting || repoPaths().defaultDataDir,
  });
}


export { existingAncestor };

export async function machineFor(context: ControlContext, run: Runner): Promise<string> {
  return computeMachineId(run, existingAncestor(context.dataDir));
}

/** Prints `<name>: E0I_X (detail)` (codes and local paths only) and returns the command's exit status. */
export function reportFailure(name: string, io: Io, error: unknown): number {
  io.stderr.write(`${name}: ${describeError(error)}\n`);
  return exitCodeOf(error);
}

export function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new ControlError('E0I_USAGE', 64, `${name} needs a value`);
  args.splice(index, 2);
  return value;
}

export function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

export function timeoutMs(value: string | undefined, fallbackSeconds: number): number {
  if (value === undefined) return fallbackSeconds * 1000;
  if (!/^[0-9]{1,4}$/.test(value)) throw new ControlError('E0I_USAGE', 64, '--timeout takes whole seconds');
  return Number(value) * 1000;
}

export function assertNoExtraArgs(args: readonly string[]): void {
  if (args.length) throw new ControlError('E0I_USAGE', 64, `unexpected argument ${args[0]}`);
}
