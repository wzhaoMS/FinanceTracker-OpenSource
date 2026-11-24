# Use Holdr with AI agents

Humans click; agents read. Holdr has two front doors. The web app is for people: you open it in a browser, sign in and
look around. AI agents use the other one: Holdr's local API, read with Holdr's **agent token**, a credential that Holdr
lets read and nothing else. Agents use it through a small **MCP server** that ships with Holdr (`agents/mcp`) and turns
the API into read-only tools that GitHub Copilot, Claude, Cursor and other agents understand, and scripts can send it
to the API directly. Both doors are on your computer: nothing about Holdr listens on your network or calls home.

```text
You ──────► web app (http://127.0.0.1:5173) ─┐
                                             ├──► Holdr API (127.0.0.1:4000) ──► finance.db in your data folder
AI agent ─► MCP server (agents/mcp, stdio) ──┤        ▲
Scripts ──► REST requests with the token ────┘        └── agent token (read-only): <data folder>/agent-token
```

This page covers what an agent can read, the agent token, how to connect each popular client (with the demo or your
own data), the API for scripts, the security model and the limits.

- [What an agent can read](#what-an-agent-can-read) · [The agent token](#the-agent-token)
- [Before you start](#before-you-start)
- [Connect your AI client](#connect-your-ai-client): [GitHub Copilot CLI](#github-copilot-cli),
  [VS Code](#vs-code-github-copilot), [Claude Desktop](#claude-desktop), [Cursor](#cursor), [others](#other-clients)
- [Things to ask](#things-to-ask)
- [Use the REST API directly](#use-the-rest-api-directly)
- [Security model](#security-model) · [Rotate or revoke the agent token](#rotate-or-revoke-the-agent-token)
- [Troubleshooting](#troubleshooting) · [Limitations](#limitations)

## What an agent can read

The MCP server offers nine tools. Every one of them only reads; there is no tool that changes, imports or deletes
anything, the server's HTTP client can send nothing but `GET` requests to a fixed list of read routes, and Holdr itself
refuses the agent token everything else (see [The agent token](#the-agent-token)).

| Tool | What it answers | Holdr API it reads |
|---|---|---|
| `holdr_health` | Is Holdr running, its database version, how many accounts and trades, each card and the date range of its transactions | `/health`, `/card-accounts`, `/spending/coverage` |
| `get_portfolio_summary` | Total value, cash, cost basis and unrealized gain; per account (brokerage, Roth IRA, 401(k), HSA, ...); allocation by account type, tax treatment, asset class and top holding; optionally time- and money-weighted returns against QQQ and SPY | `/accounts`, `/transactions`, `/quotes`, `/portfolio/performance` |
| `list_positions` | Each holding per account: quantity, average cost, cost basis, price and its freshness, value, gain, day change | `/accounts`, `/transactions`, `/quotes` |
| `list_investment_transactions` | Trades (buys, sells, options) and broker cash events (dividends, interest, contributions, withdrawals, fees) by account, symbol, type and date | `/accounts`, `/transactions`, `/cash-events` |
| `get_metals_holdings` | Gold, silver, platinum and palladium: troy ounces, units, cost, value at the latest spot close, gain; by form and by source; purchases and sales; purchase lots | `/metals/overview`, `/metals/purchases` |
| `get_spending_summary` | Card spending for a period: totals, pending, by month, category, category group, merchant, card and owner | `/card-accounts`, `/spending/summary` |
| `list_card_transactions` | Card transactions, newest first, filtered by dates, card, owner, category, merchant, kind, status or text; up to 500 per call | `/card-accounts`, `/card-transactions` |
| `get_card_benefits` | Statement credits and other card benefits: per period what was available, used and is left, days until reset, and the year's value against the annual fee | `/spending/benefits` |
| `get_spending_forecast` | This month's pace and projected total, the next three months of everyday spending (overall and by category, with ranges), upcoming recurring bills and unusual spending | `/card-accounts`, `/spending/forecast`, `/spending/patterns` |

How the answers look:

- Each answer has a one-line summary for you and compact JSON for the model. Money is in dollars (or the account's
  currency) as plain numbers. Card amounts are positive for charges and negative for refunds, credits and payments.
- Dates are `YYYY-MM-DD`. Tools that take a date range accept a `period` (`this-month`, `last-month`, `last-30-days`,
  `last-90-days`, `last-12-months`, `this-year`, `last-year`, `all-time`), a `month` (`2026-10`) or `from`/`to`.
- Investment account numbers are masked to their last four characters (`***6741`), cards are named by nickname and last
  four digits (`Alex Gold Card …1001`), and any run of six or more digits in a name, description or note is masked the
  same way.
- An answer is capped at about 75,000 characters (roughly 20,000 tokens). A longer list is cut, says so in `truncated`,
  and gives the `nextOffset` to ask for the rest.
- Portfolio values use the same quotes and the same cost-basis rules as the web app's Portfolio page. Holdr fetches
  quotes from public market-data providers for the symbols you hold (the demo uses stored prices and fetches nothing).
  Tax treatment is inferred from each account's type label; Holdr does not store one.

Not offered as tools: checking accounts and the card payment schedule (scripts can read them with the agent token; see
below). Not available to agents at all: every change (categorizing, marking a benefit used, imports), sign-in, card
sync, the full export, Amazon orders and Costco receipts. Use the web app for those.

## The agent token

Holdr makes two tokens in its data folder when it starts, each a file only you can read:

- `agent-token` is for AI agents and scripts that only read. Its value is `holdr_agent_` followed by 64 hexadecimal
  characters. Holdr accepts it for `GET` and `HEAD` on a reviewed list of read routes and refuses it everything else
  before any route runs: any other method answers `403 agent-read-only`, any other route `403 agent-route-not-allowed`.
- `service-token` is for the card sync agent and other local programs that import card statements (64 hexadecimal
  characters). Holdr lets it read what the agent token reads and run card imports (`POST /card-imports/preview`,
  `/card-imports/commit` and `/card-imports/cutover-commit`), and refuses it everything else before any route runs,
  the full export and every change to investments included (`403 principal-not-allowed`; the list, with who needs each
  entry, is in [`apps/api/src/auth/serviceScope.ts`](../apps/api/src/auth/serviceScope.ts)). It can import, so never
  give it to an AI agent: the MCP server refuses to use it, even if you point it at the file.

Where the agent token is:

| Holdr | Windows | macOS |
|---|---|---|
| Your own (`npm run start:local`) | `%LOCALAPPDATA%\Holdr\data\agent-token` | `~/Library/Application Support/Holdr/data/agent-token` |
| The demo (`npm run demo`) | `%LOCALAPPDATA%\Holdr\holdr-demo\data\agent-token` | `~/Library/Application Support/Holdr/holdr-demo/data/agent-token` |
| Development (`npm run dev`) | `apps\api\data\agent-token` in the checkout | `apps/api/data/agent-token` in the checkout |

With `--data-dir` (or `HOLDR_DATA_DIR`) Holdr uses that folder instead; on Linux the default is
`~/.local/share/holdr/data`. A Holdr started before it had agent tokens has none yet: restart it once.

What the agent token can and cannot see:

- **Can read** investments (accounts, positions, trades, broker cash events, quotes, price history, performance), card
  spending (cards, transactions, summaries, trends, benefits, forecasts, payment matching), checking accounts and the
  card payment schedule, and the gold and silver ledger. The full list is `AGENT_READ_ROUTES` in
  [`apps/api/src/auth/agentScope.ts`](../apps/api/src/auth/agentScope.ts); the main routes are in the
  [table below](#use-the-rest-api-directly).
- **Sees investment account numbers masked** to their last four characters (`***6741`); cards and checking accounts
  only ever show their last digits.
- **Cannot change anything**: no new or edited accounts or trades, no categories, benefit marks or rules, no imports.
- **Cannot reach** sign-in and sessions (`/auth/...`), the full export (`/export`), card imports, card sync and its
  pairing, the release check, or the signed-in owner's Amazon orders and Costco receipts. A route added to Holdr later
  stays closed to the agent token until it is reviewed and added to the list.
- **Works only from this computer**: on a direct connection to `127.0.0.1`, never through the web app's proxy,
  Tailscale Serve or an HTTP proxy (`401`).

## Before you start

1. **Holdr is running on this computer.** Start the demo (`npm run demo`: web app at `http://localhost:5174`, API on
   `127.0.0.1:4001`) or your own Holdr (`npm run start:local`: web app at `http://127.0.0.1:5173`, API on
   `127.0.0.1:4000`). The MCP server talks to the API, not the web app; if you start Holdr with `--api-port`, give the
   server the same port with `--app-url`. See the [README](../README.md). Holdr writes its agent token into its data
   folder when it starts; if Holdr was already running before you updated it, restart it once.
2. **Node.js 22** (22.3 or later) is on your `PATH` (`node --version`). The MCP server is plain Node.js with no
   dependencies, so it needs nothing beyond the checkout. If you installed Node.js with fnm, an AI client started from
   the Start menu, the Dock or Finder does not find `node`: give the client Node.js's own path as the command instead.
   `fnm exec --using=22 node -p process.execPath` prints it (in JSON, double each backslash).
3. **Know where your checkout is.** MCP clients start the server from their own folder, so the configuration needs the
   full path to `agents/mcp/server.mjs`. In the checkout, run `(Resolve-Path agents\mcp\server.mjs).Path`
   (PowerShell) or `echo "$PWD/agents/mcp/server.mjs"` (zsh). The examples below use `C:\Users\you\src\holdr` and
   `/Users/you/src/holdr`, the folders of [Getting started](getting-started.md).
4. **Check the setup** from the checkout. For the demo:

   ```powershell
   node agents/mcp/server.mjs --demo --check
   ```

   For your own Holdr, leave out `--demo` (add `--data-dir <folder>` if you moved your data folder). The same commands
   work in PowerShell and zsh. A working setup prints:

   ```text
   Holdr MCP server 0.1.0 (read-only)
     Holdr API       http://127.0.0.1:4001 (--demo)
     agent token     C:\Users\you\AppData\Local\Holdr\holdr-demo\data\agent-token (the demo's data folder)
     ok       the file holds Holdr's read-only agent token
     ok       the program listening on 127.0.0.1:4001 runs as you (process 12345)
     ok       Holdr is running at http://127.0.0.1:4001 (the demo, synthetic data), database schema 15: ...
   Ready. Add this server to your MCP client: docs/agents.md.
   ```

The server's options (each also reads the environment variable shown, except with `--demo`):

| Option | Variable | Default | Meaning |
|---|---|---|---|
| `--app-url` | `HOLDR_APP_URL` | `http://127.0.0.1:4000` (`:4001` with `--demo`) | Holdr's API: `http://127.0.0.1:<port>` only, never `localhost` or `[::1]` |
| `--data-dir` | `HOLDR_DATA_DIR` | `npm run start:local`'s data folder, else `apps/api/data` | Holdr's data folder, where the `agent-token` file is |
| `--token-file` | `HOLDR_AGENT_TOKEN_FILE` | `<data folder>/agent-token` | the agent token file itself; a file holding the service token is refused |
| `--demo` | | | the demo: `http://127.0.0.1:4001` and the demo's agent token (`%LOCALAPPDATA%\Holdr\holdr-demo\data\agent-token`, `~/Library/Application Support/Holdr/holdr-demo/data/agent-token`) |
| `--check` | | | check the setup, print what was found (including which kind of token the file holds), exit |

The server finds the data folder the way the card sync agent does, so if `npm run agent -- check` finds your Holdr, so
does this server. It then reads that folder's agent token, never its service token.

## Connect your AI client

Each client starts `node <checkout>/agents/mcp/server.mjs` and talks to it over standard input and output. The examples
add two servers: `holdr-demo` for the demo and `holdr` for your own data. Keep only the one you use, or keep both:
each reads only the Holdr it points at. After editing a configuration, restart the client (or reload its MCP servers).

### GitHub Copilot CLI

Add the servers from a shell:

Windows (PowerShell; PowerShell drops a bare `--` before a Copilot CLI installed with npm, so quote it):

```powershell
copilot mcp add holdr-demo '--' node C:\Users\you\src\holdr\agents\mcp\server.mjs --demo
copilot mcp add holdr '--' node C:\Users\you\src\holdr\agents\mcp\server.mjs
```

macOS (zsh):

```zsh
copilot mcp add holdr-demo -- node /Users/you/src/holdr/agents/mcp/server.mjs --demo
copilot mcp add holdr -- node /Users/you/src/holdr/agents/mcp/server.mjs
```

Or edit `~/.copilot/mcp-config.json` (`%USERPROFILE%\.copilot\mcp-config.json` on Windows) yourself. Windows:

```json
{
  "mcpServers": {
    "holdr-demo": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\you\\src\\holdr\\agents\\mcp\\server.mjs", "--demo"],
      "tools": ["*"]
    },
    "holdr": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\you\\src\\holdr\\agents\\mcp\\server.mjs"],
      "tools": ["*"]
    }
  }
}
```

macOS:

```json
{
  "mcpServers": {
    "holdr-demo": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/you/src/holdr/agents/mcp/server.mjs", "--demo"],
      "tools": ["*"]
    },
    "holdr": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/you/src/holdr/agents/mcp/server.mjs"],
      "tools": ["*"]
    }
  }
}
```

In a session, `/mcp list` shows whether each server is connected and `/mcp get holdr` lists its tools. Copilot asks
before each tool call; to let it call Holdr's read-only tools without asking for one run, start it with
`copilot --allow-tool 'holdr'` (or `'holdr-demo'`). If your data folder is elsewhere, add `"--data-dir", "<folder>"` to
`args`.

### VS Code (GitHub Copilot)

Copilot in VS Code reads the same file as Copilot CLI, so the servers above work in VS Code too. To add them from VS
Code instead, run **MCP: Add Server** from the Command Palette, choose **Command (stdio)**, enter the command (such as
`node C:\Users\you\src\holdr\agents\mcp\server.mjs --demo`) and a name (`holdr-demo`), and choose **Global**, then
**Copilot Global**: that is `~/.copilot/mcp-config.json`. A `.mcp.json` file at the root of a workspace takes the same
`mcpServers` format, for servers that only that workspace uses. Ask in the Chat view, and expand a tool call to see
which tool answered.

Older setups used VS Code's editor-managed files: `.vscode/mcp.json` in a workspace, or the `mcp.json` in your VS Code
user profile. VS Code has deprecated them, but it still forwards their servers to Copilot. They use the key `servers`,
and `.vscode/mcp.json` can name the checkout with `${workspaceFolder}`, so Holdr's tools are there only while the Holdr
checkout is open:

```json
{
  "servers": {
    "holdr-demo": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/agents/mcp/server.mjs", "--demo"]
    },
    "holdr": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/agents/mcp/server.mjs"]
    }
  }
}
```

In the user profile's `mcp.json`, give the full path to `server.mjs` instead of `${workspaceFolder}`. None of these
files holds a secret (the token stays in Holdr's data folder), but keep `.vscode/mcp.json` and `.mcp.json` out of
commits all the same: they describe your own setup.

### Claude Desktop

Open **Settings** from the Claude menu (not the account settings inside a chat), then **Developer → Edit Config**,
which opens `claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Windows:

```json
{
  "mcpServers": {
    "holdr-demo": {
      "command": "node",
      "args": ["C:\\Users\\you\\src\\holdr\\agents\\mcp\\server.mjs", "--demo"]
    },
    "holdr": {
      "command": "node",
      "args": ["C:\\Users\\you\\src\\holdr\\agents\\mcp\\server.mjs"]
    }
  }
}
```

macOS (Claude Desktop does not read your shell's `PATH`, so give the full path that `which node` prints:
`/opt/homebrew/opt/node@22/bin/node` with Homebrew's `node@22`, `/usr/local/bin/node` with the nodejs.org installer):

```json
{
  "mcpServers": {
    "holdr-demo": {
      "command": "/opt/homebrew/opt/node@22/bin/node",
      "args": ["/Users/you/src/holdr/agents/mcp/server.mjs", "--demo"]
    },
    "holdr": {
      "command": "/opt/homebrew/opt/node@22/bin/node",
      "args": ["/Users/you/src/holdr/agents/mcp/server.mjs"]
    }
  }
}
```

Quit Claude Desktop completely and start it again. In a chat, open the **Add files, connectors, and more** menu at the
bottom left of the message box, point to **Connectors**, choose **Manage connectors** and select `holdr` to see its
tools. The server's own log (what it writes to standard error) is in
`%APPDATA%\Claude\logs\mcp-server-holdr.log` on Windows and `~/Library/Logs/Claude/mcp-server-holdr.log` on macOS.

### Cursor

Put the servers in `~/.cursor/mcp.json` (`%USERPROFILE%\.cursor\mcp.json` on Windows) for every project, or in
`.cursor/mcp.json` inside one project. Windows:

```json
{
  "mcpServers": {
    "holdr-demo": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\you\\src\\holdr\\agents\\mcp\\server.mjs", "--demo"]
    },
    "holdr": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\you\\src\\holdr\\agents\\mcp\\server.mjs"]
    }
  }
}
```

macOS:

```json
{
  "mcpServers": {
    "holdr-demo": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/you/src/holdr/agents/mcp/server.mjs", "--demo"]
    },
    "holdr": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/you/src/holdr/agents/mcp/server.mjs"]
    }
  }
}
```

Cursor also accepts `${userHome}/src/holdr/agents/mcp/server.mjs`. Turn servers on or off under **Customize** in the
sidebar; if one does not start, the Output panel's **MCP Logs** shows why.

### Other clients

Any MCP client that can start a local (stdio) server works: the command is `node`, the arguments are the full path to
`agents/mcp/server.mjs` and the options above. Use `node` as the command, not `npm run mcp`: npm prints its own lines on
standard output, which the MCP protocol uses. The server speaks both kinds of MCP client: the `initialize` handshake of
protocol versions 2024-11-05 to 2025-11-25, and the per-request metadata and `server/discover` of 2026-07-28.

## Things to ask

With the demo connected, try:

- "How much of my Amex Platinum credits are still unused this quarter?" (in the demo it is Casey's card)
- "What did we spend on dining last month?"
- "How is my gold doing vs cost basis?"
- "What's our total net worth across brokerage, Roth IRA, 401(k) and HSA, and how much of it is tax-advantaged?"
- "Which holdings have the biggest unrealized gains, and what share of the portfolio do they make up?"
- "How much did we contribute to the Roth IRA this year, and how much did we get in dividends?"
- "Which card benefits reset in the next two weeks with money left on them?"
- "Are we on track to spend more than usual this month? What bills are coming up?"
- "Show the largest warehouse-club and fuel charges of the last 90 days."

Agents do best with a starting point: ask about one card, one account or one period, and let the agent follow up.

## Use the REST API directly

Scripts can read the same API with the same agent token: `holdr_agent_` and 64 hexadecimal characters in
`<data folder>/agent-token` (see [The agent token](#the-agent-token) for each folder). Send it as
`Authorization: Bearer <token>` to `http://127.0.0.1:<port>`. Holdr accepts it only on a direct connection from this
computer (not through the web app's proxy, Tailscale Serve or any HTTP proxy), so make sure no proxy is used for
`127.0.0.1` (PowerShell 7 takes `-NoProxy`; `curl` takes `--noproxy '*'`). Unlike the MCP server, a script sends the
token to whatever program answers on that port: on a computer with other user accounts, run it only while your Holdr
is running (see [Security model](#security-model)).

Windows (PowerShell; for your own Holdr use `$env:LOCALAPPDATA\Holdr\data\agent-token` and port 4000):

```powershell
$token = (Get-Content -Raw "$env:LOCALAPPDATA\Holdr\holdr-demo\data\agent-token").Trim()
$holdr = @{ Headers = @{ Authorization = "Bearer $token" } }
Invoke-RestMethod http://127.0.0.1:4001/health @holdr
(Invoke-RestMethod http://127.0.0.1:4001/accounts @holdr).accounts | Select-Object name, type, cashBalance
(Invoke-RestMethod 'http://127.0.0.1:4001/spending/summary?from=2026-10-01&to=2026-10-31' @holdr).byCategory | Select-Object -First 5
(Invoke-RestMethod http://127.0.0.1:4001/spending/benefits @holdr).resetsSoon
Remove-Variable token, holdr
```

macOS (zsh; for your own Holdr use `~/Library/Application Support/Holdr/data/agent-token` and port 4000). The token
goes to `curl` through standard input, so it never appears in the process list:

```zsh
tokenfile="$HOME/Library/Application Support/Holdr/holdr-demo/data/agent-token"
holdr() { printf 'header = "Authorization: Bearer %s"\n' "$(<"$tokenfile")" | curl --silent --fail --noproxy '*' --config - "http://127.0.0.1:4001$1"; }
holdr /health
holdr /card-accounts
holdr '/spending/summary?from=2026-10-01&to=2026-10-31'
holdr '/card-transactions?merchant=Northwind%20Market&limit=20'
```

The main read routes (all `GET`, or `HEAD`; the full list is `AGENT_READ_ROUTES` in
[`apps/api/src/auth/agentScope.ts`](../apps/api/src/auth/agentScope.ts)):

| Route | Answers |
|---|---|
| `/health` | status, schema version and counts |
| `/accounts`, `/transactions`, `/cash-events` | investment accounts (account numbers masked to their last four characters), trades, broker cash events |
| `/accounts/<id>/transactions`, `/accounts/<id>/cash-events`, `/accounts/<id>/history` | one account's trades, cash events and value history |
| `/quotes?symbols=VTI,QQQ`, `/symbols/<symbol>/history` | current quotes (up to 50 symbols) and price history |
| `/portfolio/history?range=1M`, `/portfolio/performance` | value history (`1D`, `1W`, `1M`, `3M`, `YTD`, `1Y`, `5Y`, `ALL`) and returns; `&accounts=id1,id2` narrows both |
| `/card-accounts`, `/card-transactions?...` | cards and their transactions (`from`, `to`, `cardAccountId`, `owner`, `category`, `merchant`, `q`, `kind`, `status`, `sort`, `limit` up to 200, `offset`) |
| `/spending/summary`, `/spending/coverage`, `/spending/insights`, `/spending/trend` | spending totals and breakdowns, what each card's imports cover, movers, recurring charges and the monthly trend |
| `/spending/benefits?year=2026` | the card benefits report |
| `/spending/forecast`, `/spending/patterns` | the forecast, recurring bills and unusual spending |
| `/metals/overview?metal=XAU`, `/metals/purchases`, `/metals/sales`, `/metals/timeline` | the gold and silver ledger (`XAU`, `XAG`, `XPT`, `XPD`) |
| `/checking/accounts`, `/checking/transactions?from=...&to=...` | checking accounts and their rows (`from` and `to` required, `limit` up to 500) |
| `/cash/payments`, `/cash/owed` | the card payment schedule and what is owed |

The card, spending, checking and metals routes refuse unknown query parameters (400) and anything in a query that looks
like a card number (422). Everything else answers the agent token `403`: any method but `GET` and `HEAD`
(`agent-read-only`) and any route not on the list (`agent-route-not-allowed`), such as `/export`, `/auth/me`, card
imports, card sync, Amazon orders and Costco receipts. Programs that import card statements, such as the card sync
agent, use the service token instead, which reads the same routes and runs card imports, nothing else; keep that one
away from agents.

Two command-line helpers are useful next to an agent: `node agents/mcp/server.mjs --check` (is everything in place?),
and `npm run holdr-backup` (take a backup before you import anything an agent helped you prepare). The offline
converters (`npm run holdr-card-import -- --help` and the others in [Importing data](importing-data.md)) never open the
database, and their `--dry-run` and `plan` steps write nothing, so an agent can help you prepare an import that you then
review and import yourself.

## Security model

- **Loopback only.** Holdr's API listens on `127.0.0.1` and accepts its tokens only on a direct connection from this
  computer. The MCP server refuses any `--app-url` that is not `http://127.0.0.1:<port>`, `localhost` and `[::1]`
  included (Node may try `::1` first, where Holdr does not listen). It opens no port of its own: it talks to its client
  over standard input and output.
- **Other accounts on this computer.** Any account on the computer can listen on `127.0.0.1`: while your Holdr is
  stopped, another account's program could take its port and wait for a token. Before the MCP server sends the agent
  token, it checks that the program listening on Holdr's port runs under your account (Windows: the owner of the
  listening process, through Windows PowerShell; macOS: `lsof`; Linux: `/proc/net/tcp`), and otherwise sends nothing at
  all. It checks again after 10 seconds and after any lost connection, and the card sync agent does the same with its
  token. Scripts that send a token themselves (the REST examples above) make no such check: on a computer shared with
  accounts you do not trust, run them only while your Holdr is running. On Windows, a Holdr started from an
  administrator window cannot be checked from a normal one, so start Holdr as yourself.
- **Read-only by construction.** Agents get their own token, and Holdr refuses it every change: the agent token may only
  send `GET` and `HEAD` to a reviewed list of read routes, checked before any route runs
  (`apps/api/src/auth/agentScope.ts`), and it sees account numbers masked. This holds for anything that has the token,
  not only for the MCP server. The server adds its own limits on top: nine tools that all read, an HTTP client that can
  only send `GET` to a fixed list of routes (its tests check that list against Holdr's), and it never uses the service
  token. Tool calls are rate-limited (120 a minute, 4 at a time).
- **The agent token is still a secret.** It cannot change anything, but it reads your finances. Keep the data folder
  private (`npm run start:local` creates it readable by you only), and never paste the token into a chat, a
  configuration file you share, or an issue. The server's tools never show the model the token, the token file's path
  or a full account number; `--check`, which you run yourself, prints the token file's path, so remove your user name
  before pasting its output. The server reads the token from its file on each request, so a rotated token takes effect
  at once.
- **The service token is for other programs.** `service-token`, next to the agent token, may read what the agent token
  reads and run card imports, and nothing else (`apps/api/src/auth/serviceScope.ts`): the card sync agent uses it. It
  cannot export the ledger or change investments, but a card import changes your data: never give it to an AI agent or
  put it in an MCP configuration.
- **What leaves your computer.** Holdr and the MCP server send nothing anywhere. Your AI client is different: what a
  tool answers becomes part of the conversation, which a cloud model (GitHub Copilot, Claude, Cursor, ...) receives
  under that provider's terms. Ask only about what you are comfortable sharing, or use a client with a local model.
- **Other tools in the same agent.** Card descriptions, merchant names and notes come from bank and broker exports, and
  a crafted description could try to instruct the model. The server tells the model to treat them as data, but an agent
  that also has web, e-mail or shell tools could be steered into sending your figures elsewhere. Review tool calls, and
  keep a session that reads Holdr free of tools that can publish.
- **Never expose Holdr to the internet.** Do not forward the API or web port, never run `tailscale funnel`, and do not
  tunnel the API to reach it from an agent elsewhere. Tailscale Serve is for the web app only (people on your tailnet,
  signed in); Holdr refuses its tokens through it by design. Run the agent on the computer that runs Holdr.
- **Provenance.** The server is part of this repository and has no dependencies, so it is exactly the code in your
  checkout; update it together with Holdr.

## Rotate or revoke the agent token

Delete the `agent-token` file and restart Holdr. Holdr makes a new token when it starts, and the old one stops working
at once; the MCP server picks up the new one on its next request. Do this whenever the token may have been seen by
anyone else. Deleting the file alone is not enough while Holdr runs: Holdr keeps the token it loaded until it stops.

Windows (PowerShell; for the demo, the file is `$env:LOCALAPPDATA\Holdr\holdr-demo\data\agent-token`):

```powershell
# 1. Stop Holdr (Ctrl+C in its window).
Remove-Item "$env:LOCALAPPDATA\Holdr\data\agent-token"
# 2. Start Holdr again (npm run start:local).
```

macOS (zsh; for the demo, `~/Library/Application Support/Holdr/holdr-demo/data/agent-token`):

```zsh
# 1. Stop Holdr (Ctrl+C in its window).
rm "$HOME/Library/Application Support/Holdr/data/agent-token"
# 2. Start Holdr again (npm run start:local).
```

The service token rotates the same way (delete `service-token` and restart); the card sync agent picks up the new one
on its next request. To stop agents reading Holdr altogether, remove the server from your client's configuration
(`copilot mcp remove holdr`, or delete its entry from the files above) and rotate the agent token.

## Troubleshooting

Start with `node agents/mcp/server.mjs --check` (add `--demo`, or the same `--data-dir`/`--app-url` your client passes).

| What you see | What to do |
|---|---|
| "Holdr is not running at http://127.0.0.1:4000" | Start Holdr (`npm run start:local`). For the demo, start `npm run demo` and give the server `--demo`. |
| "Holdr's agent token file (agent-token) was not found" | Holdr writes it when it starts: restart Holdr (one that was running before you updated has none yet). If Holdr uses another data folder, pass it with `--data-dir`. For the demo, use `--demo` and restart `npm run demo` if needed. |
| "this file holds Holdr's service token" | `--token-file` or `HOLDR_AGENT_TOKEN_FILE` names `service-token`. Name `agent-token` in the same folder, or leave the option out. |
| "Holdr refused the agent token" | The token belongs to another data folder, Holdr made a new one, or this Holdr is older than agent tokens: point `--data-dir` at the folder of the Holdr you run (the demo and your own Holdr have different tokens), or update and restart Holdr. |
| "Holdr's agent token file cannot be read by this account" | Run the client as the same user that runs Holdr. With Copilot CLI's sandbox on, MCP servers follow its file and network rules: allow reads of Holdr's data folder and keep `sandbox.userPolicy.network.allowLocalNetwork` on (the default), or set `sandbox.sandboxMcpServers` to `false`. |
| "... has no /... route", or "Holdr refused this read for the agent token" | Holdr and the MCP server come from different versions: update both from the same checkout. |
| "Holdr is not admitting local token requests yet (ingress-unverified)" | The hardened macOS deployment refuses token requests until its release check passes; see [Deployment](deployment.md). |
| The client shows the server as failed or with no tools | Check the full paths in the configuration and that `node --version` works in the client's environment (on macOS give `command` the full path from `which node`). Read the client's MCP log. |
| A list ends with "Output was cut to fit" | Narrow the dates or filters, or ask for the next page with the `nextOffset` it gives. |
| Prices are missing or "stale" | Holdr could not reach its quote providers; values use the last stored price. The demo always uses stored prices. |

## Limitations

- **Read-only.** Agents cannot categorize transactions, mark a benefit used, add trades or import files: Holdr refuses
  the agent token every change. Use the web app (or the import commands in [Importing data](importing-data.md)) for
  changes.
- **Not everything is exposed.** Sign-in, card sync, the full export, Amazon orders and Costco receipts are closed to
  the agent token; checking accounts and the card payment schedule can be read with it but are not offered as tools.
- **Same computer only.** The server must run where Holdr runs; it never reaches Holdr over a network.
- **Some labels are inferred.** Asset classes (`stocks, ETFs and funds`, `crypto`, `options`, `cash`) and tax
  treatment are inferred from symbols and account type labels. Spending categories are the issuers' (with Holdr's
  inferred ones); category groups take the part of the name before the first hyphen.
- **The model can still be wrong.** Tools return exact figures, but the sums, comparisons and advice in an answer are
  the model's. Check anything you act on in the web app; neither Holdr nor the model gives tax or investment advice.
- **Fresh data depends on your imports.** Card data runs through your last import (`holdr_health` shows each card's last
  date); quotes need Holdr's market-data providers; gold and silver values use stored daily closes.
- **Output is capped** at about 75,000 characters per answer; lists are paged.
- **Tested so far on Windows**, against Holdr's API with the demo household. The macOS folders and paths are covered by
  the unit tests, but the server has not yet been run end to end on a Mac. The hardened macOS deployment may refuse
  token requests until its release check passes. Linux is untested.
