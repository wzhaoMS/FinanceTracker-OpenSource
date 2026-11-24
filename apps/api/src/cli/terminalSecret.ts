/**
 * One line typed on this process's own terminal, never echoed: for an owner-only value (a membership last 4) that must
 * never reach an argument, the environment, a file other than its owner-only destination, an output line or a transcript.
 * The prompt goes to stderr; nothing typed is ever written anywhere. Refused when stdin isn't a terminal, and when the
 * operator cancels with Ctrl-C.
 */

/** Why no value was read: a closed reason. */
export class TerminalSecretRefusal extends Error {
  constructor(readonly reason: 'no-terminal' | 'cancelled') {
    super(reason);
    this.name = 'TerminalSecretRefusal';
  }
}

/** Reads printable ASCII up to Enter, with Backspace; at most `maxLength` characters are kept. */
export async function readSecretFromTerminal(prompt: string, stderr: { write(text: string): unknown },
  input: NodeJS.ReadStream = process.stdin, maxLength = 64): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new TerminalSecretRefusal('no-terminal');
  stderr.write(`${prompt}: `);
  input.setRawMode(true);
  input.resume();
  try {
    let value = '';
    for (;;) {
      const chunk = await new Promise<Buffer>((resolve) => input.once('data', (data: Buffer | string) => resolve(Buffer.from(data))));
      for (const byte of chunk) {
        if (byte === 0x03) throw new TerminalSecretRefusal('cancelled');
        if (byte === 0x0d || byte === 0x0a) {
          stderr.write('\n');
          return value;
        }
        if (byte === 0x7f || byte === 0x08) value = value.slice(0, -1);
        else if (byte >= 0x20 && byte < 0x7f && value.length < maxLength) value += String.fromCharCode(byte);
      }
    }
  } finally {
    input.setRawMode(false);
    input.pause();
  }
}
