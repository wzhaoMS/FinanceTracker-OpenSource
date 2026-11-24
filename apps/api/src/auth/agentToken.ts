import { randomBytes } from 'node:crypto';

import { loadOrCreateTokenFile, type LoadedServiceToken, type TokenFileKind } from './serviceToken.js';

/**
 * The agent token: the read-only credential for AI agents and other local programs that only read (agents/mcp). The
 * API generates it on its first start into the data directory as `agent-token`, owner-only exactly like the service
 * token (auth/serviceToken.ts), and accepts it only as `Authorization: Bearer <token>` on direct loopback connections,
 * never through the web proxy. It maps to the `agent` principal, which may send GET and HEAD to the read routes in
 * auth/agentScope.ts and nothing else: no change of any kind, no imports, no sign-in, card sync or export routes.
 *
 * The value is `holdr_agent_` followed by 64 hex characters (32 random bytes), so a person, a secret scanner or the MCP
 * server can tell it from the service token (64 hex characters alone), which can change data.
 *
 * Rotate it like the service token: delete the file and restart the API, which makes a new one; the old one stops
 * working at once.
 */

export const AGENT_TOKEN_FILE_NAME = 'agent-token';
export const AGENT_TOKEN_PREFIX = 'holdr_agent_';
export const AGENT_TOKEN_PATTERN = /^holdr_agent_[0-9a-f]{64}$/;

const AGENT_TOKEN_KIND: TokenFileKind = {
  label: 'agent token',
  generate: () => `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`,
  pattern: AGENT_TOKEN_PATTERN,
};

/** The agent token in `file`, created on first use (see loadOrCreateTokenFile for the file's rules). */
export function loadOrCreateAgentToken(file: string): LoadedServiceToken {
  return loadOrCreateTokenFile(file, AGENT_TOKEN_KIND);
}
