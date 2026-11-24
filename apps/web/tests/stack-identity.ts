/**
 * Proof that WEB_URL fronts the disposable stack scripts/e2e-disposable.mjs
 * started for this run. Its /health, fetched through WEB_URL (Vite's proxy,
 * the same path the app's API requests take), must report this run's
 * HOLDR_E2E_RUN_ID and a disposable data directory. A production API never
 * reports a run identity, and an API given one refuses to start on data that
 * is not disposable. Redirects are refused, not followed. Throws a reason
 * unless the stack is verified.
 */
export async function verifyRunIdentity(
  webUrl: string,
  expectedRunId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const origin = new URL(webUrl).origin;
  function refuse(reason: string): never {
    throw new Error(
      `Refusing to run the write-enabled e2e suite against ${origin}: ${reason} `
      + 'Run it with npm run test:e2e (scripts/e2e-disposable.mjs), which starts a disposable stack and passes its run identity.',
    );
  }
  if (!expectedRunId) refuse('HOLDR_E2E_RUN_ID is not set, so the stack cannot be verified.');
  let response: Response;
  try {
    response = await fetchImpl(new URL('/health', origin), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    refuse(`its /health could not be fetched (${(error as Error).message}${cause ? `: ${cause}` : ''}).`);
  }
  if (!response.ok) refuse(`its /health answered HTTP ${response.status}.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    refuse('its /health did not answer JSON.');
  }
  const e2e = (body as { e2e?: { runId?: unknown; disposableDataDir?: unknown } } | null)?.e2e;
  if (!e2e || typeof e2e !== 'object') {
    refuse('the API behind it reports no e2e run identity, so it is not the disposable stack started for this run (a production API never reports one).');
  }
  if (e2e.runId !== expectedRunId) {
    refuse(`the API behind it reports run identity ${JSON.stringify(e2e.runId)}, not this run's.`);
  }
  if (e2e.disposableDataDir !== true) refuse('the API behind it does not report a disposable data directory.');
}
