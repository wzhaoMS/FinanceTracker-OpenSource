/**
 * Minimal client for local scripts and agents that call the Holdr API
 * directly. The API listens on 127.0.0.1 only and accepts the service token
 * (Authorization: Bearer) only on such direct connections, never through the
 * web proxy. Run scripts on the server itself, or through an SSH tunnel:
 *
 *   ssh -N -L 4000:127.0.0.1:4000 <server>
 *
 * Environment:
 *   HOLDR_API                 base URL (default http://127.0.0.1:4000)
 *   HOLDR_SERVICE_TOKEN       token value (wins over the file)
 *   HOLDR_SERVICE_TOKEN_FILE  token path (default apps/api/data/service-token,
 *                             written by the API on its first start, mode 0600)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_API = 'http://127.0.0.1:4000';
export const DEFAULT_TOKEN_FILE = fileURLToPath(new URL('../../apps/api/data/service-token', import.meta.url));

export function serviceToken(env = process.env) {
  const fromEnv = env.HOLDR_SERVICE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = env.HOLDR_SERVICE_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (err) {
    throw new Error(
      `cannot read the Holdr service token at ${file}; start the API once to create it or set HOLDR_SERVICE_TOKEN (${err.message})`,
    );
  }
}

/** fetch() bound to the API base URL with the service token attached. */
export function holdrApi({ base = process.env.HOLDR_API ?? DEFAULT_API, token = serviceToken() } = {}) {
  const root = base.replace(/\/$/, '');
  return (path, init = {}) => fetch(`${root}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
}
