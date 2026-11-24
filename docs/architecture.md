# Architecture and limitations

## Components

- `apps/web`: React web application
- `apps/api`: Express API, authentication, import routes, and SQLite persistence
- `apps/extension`: browser extension for explicitly paired card sources; a developer preview that cannot connect as
  shipped (no bank adapters, and the hardened `dist` mode it needs stays closed until a Tailscale build is pinned)
- `agents/card-sync`: experimental local receiver for card activity handed over by a companion extension
- `agents/mcp`: the read-only MCP server that lets AI agents (GitHub Copilot, Claude, Cursor, ...) read Holdr's local
  API over standard input and output; it sends only `GET` requests to a fixed list of read routes
  ([Use Holdr with AI agents](agents.md))
- `packages/shared`: shared domain types, validators, importers, and protocol code
- `scripts`: the local launcher (`start-local.mjs`: `npm run start:local`, `npm run demo`), development, release, lifecycle, backup, and test tooling

The web application reaches the API through a same-origin proxy (the Vite dev server, or `vite preview` serving the built app) or the hardened deployment's ingress. The API owns the SQLite connection and all durable writes.

## Storage

The data folder is `HOLDR_DATA_DIR`, by default a per-user folder outside the repository (`%LOCALAPPDATA%\Holdr\data` on Windows, `~/Library/Application Support/Holdr/data` on macOS, `~/.local/share/holdr/data` on Linux) for `npm run start:local` and the `npm run holdr-*` commands that open the data folder (`holdr-user`, `holdr-backup` and the importers), and `apps/api/data` for `npm run dev` (and for the hardened deployment's `holdr-ingress`, `holdr-recovery` and `holdr-lifecycle` when neither `holdr.conf` nor the environment sets it). A new data folder is created readable by its user only. It contains:

- `finance.db`
- SQLite WAL/SHM files while the API runs
- password hashes and session digests inside the database
- `service-token`, the local service token, which the API creates on its first start (unless `HOLDR_SERVICE_TOKEN_FILE` puts it elsewhere), and `agent-token`, the read-only token for AI agents and scripts ([Use Holdr with AI agents](agents.md)); the API makes either again when it is missing, so backups leave them out
- other private runtime files created by enabled features

This directory is the security boundary. It must not be inside a public web root, synchronized to an untrusted service, or committed to Git.

## Authentication and authorization

- Users are created by a server-side CLI; there is no signup route.
- Passwords are hashed with scrypt.
- Browser sessions use random tokens; only digests are stored.
- All users share the same financial dataset.
- Two bearer tokens serve local programs, accepted only on a direct connection from the same computer (never through
  the web app's proxy or Tailscale Serve), and each only on a reviewed list of routes: a route added later stays closed
  to both until it is reviewed and listed. The service token is for programs that import card statements, chiefly the
  card sync agent: it may read what the agent token reads (and a few checks of its own) and run card imports, nothing
  else (`apps/api/src/auth/serviceScope.ts`). The agent token may only send `GET` and `HEAD` to read routes
  (`apps/api/src/auth/agentScope.ts`).
- AI agents read through the MCP server (`agents/mcp`), which only sends `GET` requests to a fixed list of read routes;
  [Use Holdr with AI agents](agents.md) describes the token it uses and what it can and cannot see.
- State-changing browser requests require an allowed origin and CSRF header.

## Networking

- The API and the web server bind loopback (`127.0.0.1`) in every setup. The API refuses to start with any other
  `HOLDR_HOST` (`E0I_BIND`), and Holdr has no LAN mode: the settings of the removed ones stop it (`E0I_LAN_REMOVED`).
- Other devices reach the web server only through Tailscale Serve (`npm run start:local -- --https-origin …`); the web server refuses unknown host names and Funnel requests.
- The hardened macOS `local` mode serves a verified release on loopback; its `dist` mode expects a private HTTPS origin and Tailscale Serve proxying a Unix socket.
- Tailscale Funnel is explicitly rejected.

## Privacy boundaries

Public quote and market-data providers receive public instruments and time ranges. They should not receive user identity, account numbers, holdings, or transaction descriptions.

Import files are parsed locally. Optional provider-specific or receipt features must be reviewed separately before enabling them.

## Current limitations

- The application is not multi-tenant.
- There is no self-service signup, password email flow, or role model.
- Restore is manual and offline.
- There is no supported public-cloud or public-internet deployment.
- Provider export formats can change and may require importer updates.
- Some advanced sync, retail, and metals workflows are operator-oriented rather than guided onboarding.
- The web app is the only supported client. The browser extension (`apps/extension`) is a developer preview that cannot connect as shipped.
