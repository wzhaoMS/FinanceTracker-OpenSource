# Holdr MCP server (read-only)

A small [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents read your local Holdr:
investments, gold and silver, card spending, card benefits and forecasts. It runs on the computer that runs Holdr, talks
to its MCP client over standard input and output, and reads Holdr's API on `127.0.0.1` with Holdr's read-only agent
token (`<data folder>/agent-token`), which Holdr allows `GET` and `HEAD` on a reviewed list of read routes and nothing
else. It has no tool that changes anything, and it refuses to use the service token, which can.

- Set it up in GitHub Copilot CLI, VS Code, Claude Desktop or Cursor: [docs/agents.md](../../docs/agents.md)
- Run it: `node agents/mcp/server.mjs [--demo] [--app-url URL] [--data-dir DIR]`; check a setup with `--check`; `--help`
  lists every option
- Tests: `node --test agents/mcp/tests/*.test.mjs` (no network; a fake Holdr API on `127.0.0.1`)

Plain Node.js (22 LTS, or 20.16 and later) with no dependencies and no build step.

| Path | What it is |
|---|---|
| `server.mjs` | the entry point |
| `lib/cli.mjs` | the command line: serve, `--check`, `--version`, `--help`; the server's instructions for the model |
| `lib/config.mjs` | flags, environment variables and defaults; the loopback-only rule and the data-folder discovery of `agents/card-sync`; the agent token file |
| `lib/protocol.mjs` | MCP over stdio (JSON-RPC 2.0, one message per line): the `initialize` handshake of protocol 2025-11-25 and earlier, and per-request `_meta` with `server/discover` of 2026-07-28 |
| `lib/holdr-api.mjs` | the HTTP client: GET only, a fixed list of read routes, the agent token read on every request (a service token is refused), loopback addresses only |
| `lib/tools.mjs` | the nine tools, their argument schemas and their answers |
| `lib/portfolio.mjs` | positions and cost basis from trades, ported from `packages/shared/src/portfolio.ts` |
| `lib/format.mjs`, `lib/schema.mjs` | money, masking, dates and the answer size budget; argument validation |
| `tests/` | `node:test` suites with synthetic data only |

## Adding a tool

1. Find the API route it needs and check that the agent token may `GET` it: the route must be on `AGENT_READ_ROUTES` in
   `apps/api/src/auth/agentScope.ts`. Adding a route there is an API change that needs its own review (it widens what
   every holder of the agent token can read) and a test in `apps/api/src/auth/agentPrincipal.test.ts`.
2. Add the route to `READ_ROUTES` in `lib/holdr-api.mjs`; `tests/holdr-api.test.mjs` checks it against the agent list.
3. Add the tool to `createTools` in `lib/tools.mjs`: a snake_case name, a title, a description that says what it returns
   and in which units, a closed input schema (`additionalProperties: false`, every property described), and a handler
   that answers `answer(summary, data, listsToCut)`. Mask account numbers (`maskAccountNumber`) and run free text through
   `cleanText`.
4. Add a fake answer to `tests/helpers.mjs` and a test to `tests/tools.test.mjs`, then update `docs/agents.md`.
