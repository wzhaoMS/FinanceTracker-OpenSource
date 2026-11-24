# Holdr documentation

New here? The [README](../README.md) says what Holdr is; [Getting started](getting-started.md) installs it. Stuck? See
[Getting help](../README.md#getting-help).

## Use Holdr

| Guide | What it covers |
|---|---|
| [Getting started](getting-started.md) | Node.js 22 and Git on Windows or macOS, getting Holdr, your sign-in, starting it, phone access, starting it automatically, backups and restore, upgrades, uninstalling, troubleshooting |
| [The demo](demo.md) | The synthetic household, a tour of what to look at, the demo's options |
| [Importing data](importing-data.md) | Offline converters and preview-first imports for card activity, statements, checking, gold and silver |
| [Card sync agent](sync-agent.md) | The experimental receiver and browser extension for American Express card activity |
| [Use Holdr with AI agents](agents.md) | The read-only MCP server, setup for GitHub Copilot, Claude, Cursor and other clients, the security model |
| [Deployment](deployment.md) | Every way to run Holdr, the settings reference, backup, upgrade and rollback, every error code |

## Advanced

| Guide | What it covers |
|---|---|
| [Costco receipts](costco-receipts.md) | Converting and importing itemized receipts from capture folders |
| [Retail item categories](retail-operator.md) | Filing receipt products under categories |
| [Staged upgrades of the hardened macOS deployment](e0i-ingress.md) | Upgrade and rollback kits for setup D (unsupported) |

## For contributors and agents

| Document | What it covers |
|---|---|
| [Architecture and limitations](architecture.md) | Components, storage, sign-in, networking, privacy boundaries |
| [Brand guide](brand.md) | Name, logo files, colors, type, screenshots |
| [AGENTS.md](../AGENTS.md) | Instructions for AI coding agents working on this repository |
| [llms.txt](../llms.txt) | A map of these docs for language models |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, checks, the privacy scan |
| [SECURITY.md](../SECURITY.md) | Reporting vulnerabilities, deployment expectations, dependency advisories |
| [MCP server](../agents/mcp/README.md), [card sync agent](../agents/card-sync/README.md) | Code layout and tests of the two agents |
| [Browser extension](../apps/extension/README.md) | The developer-preview extension shell (not usable as shipped) |
| [Fidelity investing importer](../tools/holdr-investing-sync/README.md) | An advanced importer for broker activity captures (hardened macOS deployment only) |
