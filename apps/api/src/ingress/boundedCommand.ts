import { execFile } from 'node:child_process';

export interface CommandResult {
  readonly exitCode: number | 'timeout' | 'missing' | 'overflow' | 'spawn-error';
  readonly stdout: string;
}

/** Resolves even if a grandchild retains the pipe after the direct child exits. */
export function runBoundedCommand(file: string, args: readonly string[], options: {
  timeoutMs: number; maxBuffer: number; env: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let completed = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CommandResult) => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const child = execFile(file, [...args], {
      timeout: options.timeoutMs, maxBuffer: options.maxBuffer, env: options.env,
      shell: false, encoding: 'buffer', killSignal: 'SIGKILL',
    }, (error, stdout) => {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout); }
      catch { return finish({ exitCode: 'spawn-error', stdout: '' }); }
      const code = error as (NodeJS.ErrnoException & { killed?: boolean; code?: string | number }) | null;
      // execFile can report exit 0 when its timeout closes pipes held by an exited
      // child's grandchild. A callback at/after the command deadline is still a timeout.
      const timedOut = process.hrtime.bigint() - started >= BigInt(options.timeoutMs) * 1_000_000n;
      finish({
        exitCode: timedOut ? 'timeout' : !error ? 0 : code?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'overflow'
          : code?.killed ? 'timeout' : code?.code === 'ENOENT' ? 'missing'
          : typeof code?.code === 'number' ? code.code : 'spawn-error',
        stdout: text,
      });
    });
    deadline = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ exitCode: 'timeout', stdout: '' });
    }, options.timeoutMs + 250);
    deadline.unref();
  });
}
