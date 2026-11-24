# The demo

`npm run demo` starts Holdr with a fictional household, so you can try every page before you put your own data in.
Everything in it is invented: the people, the accounts, the trades, the card spending, the prices. It has its own data
folder and its own ports, so it never touches your data. While it runs, it makes no network requests. Prices come from
the synthetic closes stored with the demo, not from a market-data provider.

- [Start it](#start-it)
- [The household](#the-household)
- [A tour](#a-tour): [Portfolio](#portfolio-accounts-and-transactions) · [Gold](#gold) ·
  [Spending](#spending-card-transactions-owed-now-payments-and-the-forecast) · [Benefits](#benefits)
- [Each new day](#each-new-day)
- [Options](#options) · [Where the demo keeps its data](#where-the-demo-keeps-its-data) · [Stop it](#stop-it)
- [Next to your own Holdr](#next-to-your-own-holdr)
- [The card sync agent and AI agents](#the-card-sync-agent-and-ai-agents)
- [Troubleshooting](#troubleshooting)

## Start it

You need Git and **Node.js 22 LTS** (22.3 or a later 22.x release) with npm. Holdr stores its data with better-sqlite3,
which ships prebuilt binaries for Node 22. On another major version, `npm ci` may try to compile it from source. The
demo checks the version and stops with a message if it is wrong.

`<repository-url>` is the HTTPS address under **Code** on the repository's GitHub page. Clone into a folder of your own,
such as `src` below, not straight into your home folder (the [README](../README.md#try-the-demo-in-2-minutes) says
why).

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\src" | Out-Null
Set-Location "$env:USERPROFILE\src"
git clone <repository-url> holdr
Set-Location holdr
npm ci
npm run demo
```

If PowerShell answers that running scripts is disabled, run
`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once, or type `npm.cmd` instead of `npm`
([Getting started](getting-started.md#windows) explains both).

macOS (zsh):

```zsh
mkdir -p ~/src && cd ~/src
git clone <repository-url> holdr
cd holdr
npm ci
npm run demo
```

The first start builds the shared package and the web app (about a minute) and makes the household (a few seconds).
Then it prints something like this:

```text
The Holdr demo is running: http://localhost:5174
  sign in as demo, password: (a new random password each start)
  demo folder: %LOCALAPPDATA%\Holdr\holdr-demo (synthetic data; safe to delete)
  everything shown is invented, and the demo makes no network requests
  it opens on localhost, so signing in here never signs you out of your own Holdr at 127.0.0.1
  stop: Ctrl+C
```

Open <http://localhost:5174> and sign in as `demo` with the password it printed. The demo uses port `5174` for the web
app and `4001` for the API, both on this computer only. Use `localhost` as printed, not `127.0.0.1`:
[Next to your own Holdr](#next-to-your-own-holdr) explains why.

## The household

Alex and Casey are a fictional couple. Holdr shows these people, folders and cards:

| What | In the demo |
| --- | --- |
| Investment accounts | About $60,000 in five accounts: Alex · Brokerage (about $15,000), Alex · Roth IRA (about $12,000), Casey · Brokerage (about $10,000), Casey · Retirement (a 401(k), about $22,000, in an S&P 500 index fund) and Casey · HSA (about $4,000). About four and a half years of trades: opening positions, then every month's contribution buying whole shares (the 401(k) buys its fund in fractional shares with each paycheck), trims, an exit, a crypto ETF in the HSA, and one stock Alex bought near its high that is now held at a loss. Two years of dividends, interest on cash and contributions. |
| Gold and silver | About half an ounce of gold in tenth- and quarter-ounce coins and 20 ounces of silver in one-ounce rounds, bought online over about three years. Two sales to a dealer in the last few months, each paid out to the checking account: a quarter-ounce coin at a gain and five silver rounds at a loss. |
| Cards | American Express Gold (Alex), American Express Platinum (Casey), a Chase Visa for everyday spending (Casey), a Citi cash-back card and a Citi Strata Elite (both joint). Fifteen months of spending: groceries, dining, fuel, travel, streaming, utilities, online shopping with returns, a December holiday spike, pending charges, annual fees and the premium cards' statement credits. |
| Statements and payments | Every card's monthly statement, paid in full by autopay on its due date, and what each issuer's site showed when the demo was made. |
| Checking | Woodgrove Bank Joint Checking: both paychecks, the mortgage, the monthly transfers to both brokerage accounts and the Roth IRA (the same amounts the accounts receive), every autopay debit, the bullion dealer's payouts, and the payments for a bullion card the household keeps out of Holdr. |

Merchant names are made up (Northwind Market, Fourth Coffee, Tailspin Fuel, and so on). Real brand names appear only
in the purchases and credits of a card benefit that names them, such as Resy, Saks, lululemon or Uber, because
Holdr's benefits catalog recognizes credits by them. Card endings are fixed made-up numbers (`1001` to `7007`). Prices
are seeded random walks, so the charts look plausible. They are not market data.

## A tour

At the top left, **Investing** shows portfolios, trades and accounts. **Everyday** shows card spending.

### Portfolio, accounts and transactions

- **Portfolio**: the household's holdings at today's synthetic close, with the day's change from the previous close.
  Choose a range on the history chart, and read the performance panel: time-weighted and money-weighted returns,
  compared with QQQ and SPY. Look for the position held at a loss in Alex's brokerage account.
- **Transactions**: every trade, filterable by account and symbol, and below them the cash activity: dividends,
  interest and contributions.
- **Accounts**: the five accounts with their cash and holdings.

### Gold

**Gold** values the bullion at the stored gold and silver closes. Switch between gold and silver at the top right.

- **All recorded history** (the top card): what was bought and what the sales brought in. The all-time profit or loss
  there reads "unavailable" in this version of Holdr. Holdr shows it only once it can verify that the purchase history
  is complete, and that check isn't available yet. The period below has the profit or loss on its sales.
- **The period** (six months by default): what was paid, what the sales brought in, and the profit or loss on those
  sales. The gold coin was sold near a high (a gain) and the silver rounds after a dip (a loss).
- **What you hold**: the coins and rounds still held, their cost, their value at the latest close and the gain.
- **Price & your trades**: the price chart with each purchase and sale marked, and **What you held**, the cost and value
  of the holdings at each month's end.
- **Details**: each purchase with the premium paid over spot, each sale with its payout linked to its deposit in the
  joint checking account, and where the figures come from.

### Spending: card transactions, Owed now, payments and the forecast

In **Everyday**, **Card transactions** is the main spending page:

- **Owed now**: what each card owes, its last statement balance and due date, and what is left to pay, as each
  issuer's site last showed it.
- The overview for a month or a longer period (60 days to 12 months, or the year to date): where the money went, what
  changed, by category, person and card, and the transactions. December is visibly higher.
- **Insights** and **Recurring charges**: what changed against a typical month, and the subscriptions and bills.
- **Card payments and checking**: each autopay matched to its debit in the checking account. Two kinds of entries are
  left over on purpose. A payment made today waits for the next bank read. The payments to the bullion card are
  listed as card payments with no card in Holdr.
- **Patterns and forecast**: where this month is heading, a range for the next months, and unusual months.

### Benefits

**Benefits** (in **Everyday**, next to **Card transactions**) is the place to see what the premium cards' statement
credits are worth. The demo fills it with three premium cards:

| Card | Person | Annual fee |
| --- | --- | --- |
| American Express Gold | Alex | $325 |
| American Express Platinum | Casey | $895 |
| Citi Strata Elite | Joint | $595 |

The everyday Chase Visa and the cash-back card have no statement credits, so they are set to **No tracked benefits**
and every card's credits count in the totals.

What to look at:

- **Use before it resets**: credits still unused in their current period, with what is left and the deadline. Monthly
  credits such as dining or digital entertainment, quarterly ones such as Resy and lululemon, half-year ones such as
  Saks.
- **The summary**: credits used against credits available this year, the annual fees, and credits minus fees. It is
  shown for the household and by person (Alex, Casey, Joint). Pick one person with **Person**.
- **By benefit** or **By card**: every benefit with each of its periods. A period is used in full (the credits that
  reimbursed it are listed with their amounts and dates), used in part, or unused. The credits post a few days after
  the purchase they reward, and the purchases are in **Card transactions** too.
- **Examples worth opening**:
  - Uber Cash never appears on a statement, so its months are marked by hand.
  - A streaming credit posted two days into the next month counts for the month before (the grace rule).
  - A Saks credit was taken back after a return, so that half-year counts as unused.
  - The Platinum card's Global Entry credit was used, so it shows when it is available again. The Strata Elite's
    Global Entry credit is still unused.
- **Last year**: the year arrows go back to last year's complete periods.

You can mark a period yourself, change a card's product or anniversary month, and see the totals change. Those changes
stay until the demo is made again (see below).

## Each new day

The demo's data runs up to today's date in New York (the market's calendar). The first time you start it on a later
day, it is made again for that day. Prices, statements, spending and credits then run up to the new today, so the demo
never looks out of date. Card months and benefit periods that are already over look the same as before. The
portfolio's prices and trades are generated again around the new day.

- Making it again replaces everything in the demo folder, including changes you made (marks, settings, trades).
  To keep them, start with `--keep-data`. The data then stays as it was on the day it was made.
- `--reset` deletes the demo folder and makes the household again, whatever day it is.
- The demo deletes only a folder it made and that holds nothing else: its `.holdr-demo` marker, word for word, and a
  `data` folder with Holdr's own files, whose database has only the demo household and the `demo` user. If it finds
  anything else (a file, or a user, account, card or card statement import the demo did not make), it stops, deletes
  nothing, and says what it found.

```powershell
npm run demo -- --keep-data
npm run demo -- --reset
```

(The same commands work in zsh.)

## Options

Give options after `--`, as in `npm run demo -- --reset`. `npm run demo -- --help` lists them all.

| Option | What it does |
| --- | --- |
| `--reset` | Delete the demo folder and make the household again. |
| `--keep-data` | Keep the demo data as it is, even when it was made on an earlier day. |
| `--password-stdin` | Read the demo user's password from standard input instead of making a new random one. Without input redirection, it asks you to type it (it shows as you type). |
| `--data-dir DIR` | Use another demo folder. It must be new, or a folder the demo made (it holds a `.holdr-demo` file). |
| `--api-port N`, `--web-port N` | Other ports (the defaults are 4001 and 5174). |
| `--dev` | Serve the web app with Vite's dev server (hot reload) instead of the build. |
| `--rebuild` | Rebuild the shared package and the web app first. |

`--https-origin` is not available with the demo: it runs on this computer only. Prefer the printed random password, or
`--password-stdin`, over `--password`, because other programs on the computer can see command-line arguments.

To pipe a password in with `--password-stdin`, PowerShell must pipe into `npm.cmd`, not `npm`: PowerShell's `npm`
drops the `--` when input is piped, so the option never reaches the demo, which then makes a random password.

Windows (PowerShell), with the password in `$pw`:

```powershell
$pw | npm.cmd run demo -- --password-stdin
```

macOS (zsh), with the password in `$pw`:

```zsh
printf '%s\n' "$pw" | npm run demo -- --password-stdin
```

## Where the demo keeps its data

| Operating system | Demo folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Holdr\holdr-demo` |
| macOS | `~/Library/Application Support/Holdr/holdr-demo` |
| Linux | `~/.local/share/holdr/holdr-demo` (or under `$XDG_DATA_HOME`) |

The folder is readable by you only. It holds `.holdr-demo`, which marks it as the demo's and records the day the data
was made, and `data`, which holds the database and the API's two tokens: `agent-token`, the read-only token AI agents
use, and `service-token`, which the card sync agent uses. Deleting the folder is safe. The next `npm run demo` makes it
again.

Keep your own data out of it. `npm run start:local` and the `npm run holdr-*` commands refuse a data folder in the demo
folder (with `--data-dir` or `HOLDR_DATA_DIR`), because the demo deletes that folder when it makes the demo again.

## Stop it

Press **Ctrl+C** in the window where the demo runs. That stops the API and the web server. In Windows PowerShell, if
npm then asks `Terminate batch job (Y/N)?`, answer `Y`: the demo has already stopped.

If you closed the window and a port stays busy, find the process listening on it and stop that process.

Windows (PowerShell):

```powershell
Get-NetTCPConnection -LocalPort 4001, 5174 -State Listen | Select-Object LocalPort, OwningProcess
Stop-Process -Id <OwningProcess>
```

macOS (zsh):

```zsh
lsof -nP -iTCP:4001 -iTCP:5174 -sTCP:LISTEN
kill <PID>
```

## Next to your own Holdr

The demo and `npm run start:local` can run at the same time: they use different folders and ports. They also use
different addresses, the demo `http://localhost:5174` and your own Holdr `http://127.0.0.1:5173`. A browser keeps one
set of sign-in cookies per host name, whatever the port. If you opened the demo at `127.0.0.1:5174`, signing in there
would sign you out of your own Holdr at `127.0.0.1:5173`, and the other way round.

The demo also reads nothing of your own setup. It ignores the repository's `.env` file and Holdr settings in the
environment, and its servers get only the system's own variables (the program path, the home and temporary folders,
and the locale).

## The card sync agent and AI agents

**The card sync agent** (experimental; [docs/sync-agent.md](sync-agent.md)) can be pointed at the demo to see how
pairing and its checks work. Give it the demo's API, web address and data folder. The demo's cards are fictional, so
do not sync real statements into it.

Windows (PowerShell):

```powershell
npm run agent -- check --app-url http://127.0.0.1:4001 --web-url http://localhost:5174 --data-dir "$env:LOCALAPPDATA\Holdr\holdr-demo\data"
```

macOS (zsh):

```zsh
npm run agent -- check --app-url http://127.0.0.1:4001 --web-url http://localhost:5174 --data-dir "$HOME/Library/Application Support/Holdr/holdr-demo/data"
```

**AI agents** (GitHub Copilot, Claude, Cursor and others) can read the demo through Holdr's read-only MCP server.
[docs/agents.md](agents.md) shows how to connect each client. Its `--demo` option points the server at the demo's API
and data folder:

```powershell
node agents/mcp/server.mjs --demo --check
```

If you started the demo with other ports or another folder, give the server `--app-url http://127.0.0.1:<api port>`
and `--data-dir <demo folder>/data` instead of `--demo`. Some questions to try: "Which Platinum credits are still
unused this quarter, and when do they reset?", "How much did we spend on dining last month compared with a typical
month?", "What did the gold sales gain or lose?"

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `Holdr needs Node.js 22 ...` | Install Node.js 22 LTS (22.3 or a later 22.x release), open a new window, run `npm ci` again, then `npm run demo`. |
| `the API port 4001 is in use` (or the web port 5174) | The demo is probably running already, in another window. Stop it first ([Stop it](#stop-it)), or start this one with `--api-port` and `--web-port`. |
| `... exists but is not a demo folder` | `--data-dir` names a folder the demo did not make. Choose a new folder. The demo deletes nothing without its own `.holdr-demo` marker. |
| `the demo folder ... holds ..., so it is not deleted` | The demo folder has something the demo did not make: a file beside `data`, a file in `data` that is not Holdr's, or a user, account, card or card statement import in its database. The demo deletes nothing it did not make. If nothing in it is yours, delete the folder yourself ([Where the demo keeps its data](#where-the-demo-keeps-its-data)), then start again. `--keep-data` keeps using it as it is, unless it has a sign-in user other than `demo`. |
| `the demo folder ... could not be moved aside` | Something still uses the demo folder, usually the demo running in another window. Stop it there, then start again. Nothing was deleted. |
| `the old demo folder ... could not be deleted` | The demo was made again, but its old copy (`holdr-demo.old-…`, next to the demo folder) is still in use. Delete it once nothing uses it. |
| `the data folder ... is in the demo's folder` | `npm run start:local` or an `npm run holdr-*` command was given a data folder in the demo folder. Leave out `--data-dir` and `HOLDR_DATA_DIR` to use your own default folder, or choose another. |
| The password does not work | Each start sets a new random password. Use the one from the window you started last. |
| Signed out of your own Holdr | Open the demo at `http://localhost:5174`, as printed, not at `127.0.0.1`. |
| `seeding the demo failed` | Run `npm run demo -- --reset`. If it fails again, run `npm ci` and try once more. |
| The page says the server is unreachable | The API stopped. The demo window shows why. Start it again. |
| Prices never change during the day | That is expected: the demo's prices are the stored synthetic closes. They move forward when the demo is made again on a new day. |
