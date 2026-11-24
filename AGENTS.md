# AGENTS.md

Instructions for AI coding agents working in this repository. People should start with [README.md](README.md) and
[CONTRIBUTING.md](CONTRIBUTING.md); everything here applies to them too. To *use* Holdr's data from an agent (rather than
change its code), see [docs/agents.md](docs/agents.md).

## Project overview

Holdr (the repository is FinanceTracker) is a self-hosted personal finance app for one U.S. household: investments
(brokerage, Roth IRA, 401(k), HSA), physical gold and silver, everyday credit-card spending, card benefits and statement
credits, spending forecasts, checking accounts and receipts. It runs on the owner's Windows or macOS computer with a
local SQLite database, binds `127.0.0.1` only, has no telemetry, and reaches the internet only for public market data.
Treat every change as touching someone's real finances.

| Path | What it is |
|---|---|
| `apps/api` | Express API, sign-in, imports, SQLite persistence (`better-sqlite3`), command-line tools (`src/cli/*Main.ts`) |
| `apps/web` | React web app (Vite), served through a same-origin proxy to the API |
| `apps/extension` | browser extension for paired card sources (preview, no bank adapters) |
| `packages/shared` | domain types and pure logic shared by everything: portfolio math, card import, spending, benefits, forecasts, metals ledger (built to `dist/`) |
| `agents/card-sync` | experimental local receiver and browser extension for American Express statements |
| `agents/mcp` | read-only MCP server for AI agents (plain Node.js, no dependencies) |
| `scripts` | the local launcher (`start-local.mjs`), privacy scan, test runners, e2e stack, deployment and backup tooling |
| `tools` | runtime validators the API loads (`amazon-capture`) and advanced importers |
| `docs` | documentation for using, importing into and deploying Holdr |

## Setup

- Node.js 22 LTS (20.16 or later works; 21.x and 22.0 to 22.2 do not) and npm 10 or later.
- `npm ci` installs everything and builds `packages/shared` (its `prepare` step). After changing `packages/shared`,
  rebuild it: `npm run build --workspace @finance-tracker/shared`.
- On Windows, run commands in a normal, not elevated, PowerShell. If the execution policy blocks `npm.ps1` or `npx.ps1`,
  call `npm.cmd` and `npx.cmd` instead (`npm.cmd ci`, `npx.cmd vitest ...`).

## Run it

Use the synthetic demo or the development database, never the owner's data folder:

| What | Command | Where |
|---|---|---|
| Demo household, offline | `npm run demo` (`-- --reset` starts it over) | API `127.0.0.1:4001`, web `127.0.0.1:5174`, data in `%LOCALAPPDATA%\Holdr\holdr-demo` or `~/Library/Application Support/Holdr/holdr-demo` |
| Development with hot reload | `npm run holdr-user -- add dev --data-dir apps/api/data`, then `npm run dev` | API `127.0.0.1:4000`, web via Vite; data in `apps/api/data` (git-ignored) |
| The owner's own Holdr | `npm run start:local` | API `127.0.0.1:4000`, web `127.0.0.1:5173`, the per-user data folder: do not start, stop or read it unless asked |

`node scripts/start-local.mjs --help` lists the launcher's options. To read the demo's data while you work, connect the
MCP server: `node agents/mcp/server.mjs --demo --check`, then [docs/agents.md](docs/agents.md).

## Build, typecheck and test

Before a pull request, from the repository root:

```powershell
npm run typecheck
npm run build
npm test
git add -A
npm run privacy:scan
```

While you work, run the smallest set that covers the change:

| Area | Typecheck | Tests |
|---|---|---|
| `packages/shared` | `npm run typecheck --workspace @finance-tracker/shared` | `npm test --workspace @finance-tracker/shared` |
| `apps/api` | `npm run typecheck --workspace @finance-tracker/api` | `npx vitest run --root apps/api src/<path>.test.ts` (one file or a folder) |
| `apps/web` | `npm run typecheck --workspace @finance-tracker/web` | `npm run test:unit --workspace @finance-tracker/web`; `npm test --workspace @finance-tracker/web` (Playwright harness) |
| `apps/extension` | `npm run typecheck --workspace @finance-tracker/extension` | `npm test --workspace @finance-tracker/extension` |
| `agents/card-sync` | | `npm run test:agent` |
| `agents/mcp` | | `node --test agents/mcp/tests/*.test.mjs` |
| `scripts` | | `node --test scripts/<name>.test.mjs` |
| End to end | | `npm run test:e2e` (a disposable stack with synthetic data) |

The API suite (about 300 files) runs serially in a single fork because of the native SQLite module, so a full run takes
long, especially on Windows. With a command timeout, run it in bounded batches with Vitest's sharding and check each
batch before the next:

```powershell
npx vitest run --root apps/api --shard=1/8
npx vitest run --root apps/api --shard=2/8
```

and so on to `--shard=8/8`, or a folder at a time (`npx vitest run --root apps/api src/routes`). The ingress and
production-stack integration suites are separate and slow: `npm run test:ingress --workspace @finance-tracker/api` and
`npm run test:stack --workspace @finance-tracker/api`.

Platform caveats:

- **Windows, elevated shells.** Files an elevated (administrator) shell creates belong to Administrators, which the
  owner-only ACL checks rightly refuse: tests that create private folders then fail. Run tests from a normal shell.
- **Windows, ACL reads.** Some tests read ACLs through Windows PowerShell 5.1, a few hundred milliseconds each; the API
  suite raises its timeout to 60 seconds on Windows for them.
- **macOS-only and Windows-only tests skip elsewhere** (`O_SHLOCK` locks, the native path checker, POSIX modes, ACLs).
- **Loopback only (P-NET).** Test processes may listen on `127.0.0.1` or `::1` only, named as those literals;
  `scripts/loopback-only.mjs` (loaded by the test runners) refuses anything else, `localhost` included. Start any child
  server on `127.0.0.1`. Tests make no outbound network requests.

## Code style and conventions

- TypeScript in strict mode for `apps/*` and `packages/*`; plain ES modules (`.mjs`) for `scripts/` and `agents/`.
  ES module imports with explicit `.js` specifiers in TypeScript; Node built-ins as `node:fs`, `node:path`, ...
- Two-space indentation, single quotes, semicolons, trailing commas in multi-line literals, lines up to about 130
  characters. Match the surrounding file.
- Comments explain why and the contract (what a function answers, what it refuses), in plain sentences; JSDoc on exported
  functions. Keep them true when you change the code.
- Money is integer minor units (`amountMinor`, `costMinor`) in the card, checking and metals domains, parsed from text
  exactly, never through floating point. Importers refuse what is ambiguous or incomplete instead of guessing.
- Imports are preview-first; a commit is one database transaction; command-line imports change the database only under
  an authorization file the owner writes (a GO file; see `docs/importing-data.md`) and take a backup first.
- API errors and logs are value-free: never echo request values, database messages, amounts, descriptions or account
  numbers. Card spending routes refuse unknown query parameters.
- Security boundaries are deliberate: the API binds loopback; the service token is accepted only from direct loopback
  connections and is limited on card routes (`apps/api/src/auth/serviceScope.ts`); the agent token (for AI agents) is
  accepted the same way and may only `GET` or `HEAD` the reviewed read routes in `apps/api/src/auth/agentScope.ts`;
  state-changing browser requests need an allowed origin and the CSRF header; Tailscale Funnel is refused. Do not widen
  any of them without an explicit request, and add tests when you touch them. A new read route stays closed to agents
  until it is reviewed and added to the agent list.
- Tests sit next to the code (`*.test.ts`; `*.test.mjs` for scripts and agents) and use synthetic data only.
- User documentation is plain and direct, and shows every command for Windows PowerShell and macOS zsh when they differ.

## Privacy rules

These are hard rules, not preferences:

- Never commit, print or paste real data: databases (`*.db`), statements, exports, receipts, screenshots, names,
  addresses, e-mail addresses, phone numbers, account numbers or endings, machine paths, private host names, tailnet
  names, tokens, `.env`, `holdr.conf`, backups.
- Do not open the owner's data folder, `.env`, `holdr.conf` or its tokens (`service-token`, `agent-token`) unless the
  task requires it and the owner asked; work against the demo or `apps/api/data`.
- Fixtures are generated or clearly synthetic: `example.com`, `holdr.example.ts.net`, documentation IP ranges
  (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), published test card numbers, invented merchants and people.
  In docs, home folders are `C:\Users\you` and `/Users/you`.
- Run `npm run privacy:scan` before every commit. It scans the staged index and fails on unstaged or untracked files,
  so stage first (`git add -A`); `node scripts/privacy-scan.mjs --worktree` scans the working tree. Personal terms
  belong in the git-ignored `.privacy-scan.local`, never in the repository. When you find a new kind of sensitive data,
  add a rule and a test to `scripts/privacy-scan.mjs`.
- Add no telemetry, analytics or network calls beyond the public market-data providers Holdr already uses.

## Where documentation lives

| Topic | File |
|---|---|
| Overview, install, demo, everyday use | `README.md` |
| Index of every guide | `docs/README.md` |
| Step-by-step install on Windows and macOS | `docs/getting-started.md` |
| The demo household | `docs/demo.md` |
| Contributing, checks, privacy scan | `CONTRIBUTING.md` |
| Vulnerability reports, deployment expectations | `SECURITY.md` |
| Components, storage, authentication, networking | `docs/architecture.md` |
| Setups, settings reference, backups, upgrades | `docs/deployment.md` |
| Converters and importers | `docs/importing-data.md` |
| Card sync agent | `docs/sync-agent.md`, `agents/card-sync/README.md` |
| AI agents: the agent token, the MCP server and the REST API | `docs/agents.md`, `agents/mcp/README.md` |
| Hardened macOS upgrades | `docs/e0i-ingress.md` |
| Receipts and their item categories | `docs/costco-receipts.md`, `docs/retail-operator.md` |
| Browser extension | `apps/extension/README.md` |
| Name, logo, colors, screenshots | `docs/brand.md` |

Update the documentation a change affects, in the same pull request.

## Pull request checklist

- [ ] The change is focused, and its tests cover the new or changed behavior (synthetic data only).
- [ ] `npm run typecheck`, `npm run build` and the relevant tests pass; the API suite in shards if needed.
- [ ] Windows and macOS both considered: paths, permissions, shells, line endings.
- [ ] Security boundaries are unchanged, or the change says why and tests the new boundary.
- [ ] Documentation updated, with PowerShell and zsh commands where they differ.
- [ ] `git add -A`, then `npm run privacy:scan` passes.
- [ ] No real data, secrets, tokens, machine paths or personal names anywhere in the diff.
