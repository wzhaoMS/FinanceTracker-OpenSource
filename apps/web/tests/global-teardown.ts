import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { request, type FullConfig } from '@playwright/test';

import { AUTH_STATE_FILE, apiHeaders } from './authState';

/** Ends the shared session server-side and deletes the saved cookie. */
export default async function globalTeardown(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL || !existsSync(AUTH_STATE_FILE)) return;
  const context = await request.newContext({ baseURL, storageState: AUTH_STATE_FILE, extraHTTPHeaders: apiHeaders(baseURL) });
  try {
    await context.post('/auth/logout').catch(() => undefined);
  } finally {
    await context.dispose();
    await rm(AUTH_STATE_FILE, { force: true });
  }
}
