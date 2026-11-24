import { fileURLToPath } from 'node:url';

/**
 * Signed-in browser state written by global-sign-in.ts and shared by every
 * test. scripts/e2e-disposable.mjs keeps it in the run directory, outside
 * anything Vite serves, and deletes it when the run ends; the fallback is gitignored.
 */
export const AUTH_STATE_FILE = process.env.HOLDR_E2E_AUTH_STATE
  || fileURLToPath(new URL('../playwright/.auth/state.json', import.meta.url));

/** Headers a browser adds itself; Playwright's API client must send them explicitly. */
export function apiHeaders(baseURL: string): Record<string, string> {
  return { Origin: new URL(baseURL).origin, 'X-Holdr-Request': '1' };
}

export function e2eCredentials(): { username: string; password: string } {
  const username = process.env.HOLDR_E2E_USER ?? '';
  const password = process.env.HOLDR_E2E_PASSWORD ?? '';
  if (!username || !password) {
    throw new Error(
      'Set HOLDR_E2E_USER and HOLDR_E2E_PASSWORD to a user of the disposable test stack, created there with '
      + '`printf %s "$HOLDR_E2E_PASSWORD" | npm run holdr-user -- add "$HOLDR_E2E_USER" --password-stdin`.',
    );
  }
  return { username, password };
}
