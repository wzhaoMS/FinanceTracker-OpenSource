#!/usr/bin/env node
// Holdr MCP server (read-only): gives AI agents read access to your local Holdr over the Model Context Protocol, on
// standard input and output. An MCP client (GitHub Copilot CLI, VS Code, Claude Desktop, Cursor, ...) starts it; see
// docs/agents.md. Plain Node.js (22 LTS, or 20.16 and later), no dependencies and no build step:
//
//   node agents/mcp/server.mjs [--demo] [--app-url URL] [--data-dir DIR] [--token-file FILE]
//   node agents/mcp/server.mjs --check      (is everything in place? prints for a person, then exits)
//   node agents/mcp/server.mjs --help
import { main } from './lib/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
