import { WebReleaseError } from '@finance-tracker/shared/web-release';

/**
 * A value-free control-plane refusal (design §7.2, §9): a stable `E0I_*` code, the exit status the
 * CLIs use for it, and an optional detail that names a setting or a local path, never data.
 */
export class ControlError extends WebReleaseError {
  constructor(code: string, readonly exitCode = 1, readonly detail?: string) {
    super(code);
    this.name = 'ControlError';
  }
}

export const EXIT = Object.freeze({ refused: 1, maintenance: 3, leaseRequired: 3, completedButBlocked: 5, busy: 75, usage: 64 });

export function fail(code: string, detail?: string, exitCode: number = EXIT.refused): never {
  throw new ControlError(code, exitCode, detail);
}

/** `E0I_X (detail)` for logs: codes and local paths only. */
export function describeError(error: unknown): string {
  if (error instanceof ControlError) return error.detail ? `${error.code} (${error.detail})` : error.code;
  if (error instanceof WebReleaseError) return error.code;
  return 'E0I_INTERNAL';
}

export function exitCodeOf(error: unknown): number {
  return error instanceof ControlError ? error.exitCode : EXIT.refused;
}
