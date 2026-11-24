/** The run id shared by one `playwright test` invocation and its workers: a timestamp and one random byte (short, for Windows MAX_PATH). */
import { randomBytes } from 'node:crypto';

export function newRunId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}${randomBytes(1).toString('hex')}`;
}
