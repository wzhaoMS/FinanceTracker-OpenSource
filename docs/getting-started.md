# Getting started

This guide installs Holdr on **Windows 10 or 11** (PowerShell) or **macOS** (zsh, the Terminal's shell) and runs it
with your own data, step by step. To look around first, do steps 1 and 2 and then start the [demo](demo.md).

Every command runs in the folder you cloned (the *checkout*) unless a step says otherwise. Where PowerShell and zsh
differ, both are shown.

- [1. Install Node.js 22 and Git](#1-install-nodejs-22-and-git)
- [2. Get Holdr](#2-get-holdr)
- [3. Create your sign-in](#3-create-your-sign-in)
- [4. Start Holdr](#4-start-holdr)
- [5. Get your data in](#5-get-your-data-in)
- [6. Use Holdr from your phone or another computer](#6-use-holdr-from-your-phone-or-another-computer)
- [7. Start Holdr automatically](#7-start-holdr-automatically)
- [8. Back up and restore](#8-back-up-and-restore)
- [9. Upgrade, or go back to an older version](#9-upgrade-or-go-back-to-an-older-version)
- [10. Uninstall](#10-uninstall)
- [What runs where](#what-runs-where) · [Where your data lives](#where-your-data-lives) ·
  [Troubleshooting](#troubleshooting) · [Getting help](../README.md#getting-help)

## 1. Install Node.js 22 and Git

Holdr needs **Node.js 22**, release 22.3 or later (npm comes with it), and **Git**.

- **Node.js 24 and 26 are not supported yet.** Holdr's SQLite module (`better-sqlite3` 11.10) ships prebuilt binaries
  for Node.js 22 but not for 24 or 26, so `npm ci` would try to compile it, and the hardened macOS deployment pins
  Node.js 22. `npm run start:local` and `npm run demo` refuse other versions.
- Node.js 22 receives security fixes until 30 April 2027.
- The checkout's `.nvmrc` and `.node-version` files say `22`, so version managers such as fnm and nvm pick it up.

### Windows

Open **PowerShell** from the Start menu and install both with winget:

```powershell
winget install -e --id OpenJS.NodeJS.22
winget install -e --id Git.Git
```

Use the id `OpenJS.NodeJS.22`, not `OpenJS.NodeJS.LTS`: the LTS package now installs Node.js 26. Without winget,
download the Node.js 22 installer from <https://nodejs.org/dist/latest-v22.x/> (`node-v22.x.y-x64.msi`, or
`node-v22.x.y-arm64.msi` on an ARM PC) and Git from <https://git-scm.com/download/win>.

Close PowerShell, open a new window, and check that `node --version` prints `v22.` with a minor version of 3 or more
(such as `v22.23.5`):

```powershell
node --version
git --version
```

**Windows PowerShell 5.1 and `npm`.** The PowerShell built into Windows runs `npm` as a script, and its default policy
blocks that ("running scripts is disabled on this system"). Allow scripts you run yourself, once (no administrator
rights needed):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Alternatively, type `npm.cmd` wherever these docs say `npm`, or install PowerShell 7
(`winget install -e --id Microsoft.PowerShell`) and use **PowerShell 7**, which needs neither.

**With a version manager instead.** fnm switches to Node.js 22 when you enter the checkout:

```powershell
winget install -e --id Schniz.fnm
```

Then, in a new PowerShell window:

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
fnm install 22
fnm default 22
```

Add the first line to your PowerShell profile so that every new window gets it. The profile file often does not exist
yet, so create it first, then paste the line into Notepad and save:

```powershell
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Force $PROFILE | Out-Null }
notepad $PROFILE
```

fnm puts `node` on `PATH` only in windows that load your profile. Programs that start Node.js themselves, such as AI
clients and auto-start, need the path of Node.js itself, which `fnm exec --using=22 node -p process.execPath` prints
([step 7](#7-start-holdr-automatically), [AI agents](agents.md)).

### macOS

Install Apple's command line tools, which include Git:

```zsh
xcode-select --install
```

Then install Node.js 22 in one of these ways:

- **Homebrew**, on a Mac with Apple silicon and macOS 15 or later:

  ```zsh
  brew install node@22
  echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
  source ~/.zshrc
  ```

  `node@22` is a versioned formula, so Homebrew does not put it on your `PATH` (the second line does). Homebrew lists
  it as deprecated because Node.js 22 is in maintenance; it still installs and works.
- **The installer**, on any Mac, Intel included: `node-v22.x.y.pkg` from <https://nodejs.org/dist/latest-v22.x/>.
- **fnm**, which switches to Node.js 22 when you enter the checkout:

  ```zsh
  brew install fnm
  echo 'eval "$(fnm env --use-on-cd --shell zsh)"' >> ~/.zshrc
  source ~/.zshrc
  fnm install 22
  fnm default 22
  ```

  With nvm instead: `nvm install 22`, and `nvm use` in the checkout (it reads `.nvmrc`). fnm's `node` is a link that
  lasts only as long as the Terminal window, so auto-start and AI clients need the path of Node.js itself:
  `fnm exec --using=22 node -p process.execPath` prints it ([step 7](#7-start-holdr-automatically)).

Open a new Terminal window and check that `node --version` prints `v22.` with a minor version of 3 or more:

```zsh
node --version
git --version
```

### Only if `npm ci` compiles the SQLite module

With Node.js 22 on Windows (x64 or ARM64) or macOS (Apple silicon or Intel), `npm ci` downloads a prebuilt
`better-sqlite3` and compiles nothing. If it compiles anyway (you see `node-gyp` or `gyp ERR!`), check
`node --version` first. Only if you need to compile:

- Windows: Python 3 and the Visual Studio Build Tools with "Desktop development with C++":

  ```powershell
  winget install -e --id Python.Python.3.12
  winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```

- macOS: the command line tools from `xcode-select --install` (above).

## 2. Get Holdr

`<repository-url>` is the HTTPS address under **Code** on the repository's GitHub page. Clone it into a folder of your
own, such as `src` below, not straight into your home folder: Holdr keeps your private files in a folder named `Holdr`
in your home folder (`%USERPROFILE%\Holdr`, `~/Holdr`), and on Windows and macOS `holdr` and `Holdr` are the same name.

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\src" | Out-Null
Set-Location "$env:USERPROFILE\src"
git clone <repository-url> holdr
Set-Location holdr
npm ci
```

macOS (zsh):

```zsh
mkdir -p ~/src && cd ~/src
git clone <repository-url> holdr
cd holdr
npm ci
```

`npm ci` installs the dependencies (about 2 GB of disk space) and builds the shared package. Run it again after every
upgrade.

**Try the demo now** if you like: `npm run demo` (both shells), then open <http://localhost:5174> and sign in with the
user name and password it prints. Press **Ctrl+C** to stop it. It has its own data folder and its own ports (web
`5174`, API `4001`), runs offline with synthetic prices, and never touches your data. The first start on a new day
makes the demo data again for that day (`--keep-data` keeps it; see [Each new day](demo.md#each-new-day)).
[The demo](demo.md) explains the rest.

## 3. Create your sign-in

Users are created on the computer that runs Holdr; there is no sign-up page. Create yours (it asks for a password of
at least 8 characters, twice):

Windows (PowerShell) and macOS (zsh):

```powershell
npm run holdr-user -- add alex
```

Add more people the same way; every signed-in user sees the same household data. `npm run holdr-user -- --help` lists
the other commands (`list`, `passwd`, `remove`). The first `add` creates your data folder, readable by your account
only ([Where your data lives](#where-your-data-lives)).

To create a user from a script, pipe the password (one line) in with `--password-stdin`.

Windows (PowerShell), with the password in `$password`. Pipe into `npm.cmd`, not `npm`: PowerShell's `npm` drops the
`--` when input is piped, and the command then fails. In Windows PowerShell 5.1, first set the pipe's encoding, or
characters outside ASCII reach Holdr as `?`:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$password | npm.cmd run holdr-user -- add alex --password-stdin
```

macOS (zsh), with the password in `$password`:

```zsh
printf '%s\n' "$password" | npm run holdr-user -- add alex --password-stdin
```

## 4. Start Holdr

Windows (PowerShell) and macOS (zsh):

```powershell
npm run start:local
```

Open <http://127.0.0.1:5173> and sign in. Press **Ctrl+C** in that window to stop Holdr.

`npm run start:local` creates your data folder if it is missing (readable by you only), builds the shared package and
the web app when they are missing or out of date (the first start takes about a minute), starts the API on
`127.0.0.1:4000` and the web app on `127.0.0.1:5173`, and stops both on Ctrl+C. Its options, passed after `--` (for
example `npm run start:local -- --web-port 5200`):

| Option | What it does |
|---|---|
| `--data-dir <folder>` | use another data folder (also `HOLDR_DATA_DIR`) |
| `--api-port <n>`, `--web-port <n>` | other ports (defaults 4000 and 5173) |
| `--https-origin https://<machine>.<tailnet>.ts.net` | serve your other devices through Tailscale Serve ([step 6](#6-use-holdr-from-your-phone-or-another-computer)) |
| `--dev` | Vite's development server with hot reload instead of the built app |
| `--rebuild` | rebuild the shared package and the web app first |
| `--help` | list the options, the demo's included |

### Settings

`npm run start:local` and the `npm run holdr-*` commands that open your data folder (`holdr-user`, `holdr-backup` and
the importers such as `holdr-checking`, `holdr-retail` and `holdr-metals`) read a `.env` file in the checkout if
there is one; variables already set in your environment win. Nothing else reads it: not the demo, which uses only its
own settings; not the offline converters (`holdr-card-import` and the `holdr-*-convert` commands), which need no
settings; not `npm run dev`; not the card sync agent or the MCP server, which take options or environment variables;
and not the hardened deployment, which reads `holdr.conf`. Start from the example:

Windows (PowerShell):

```powershell
Copy-Item .env.example .env
notepad .env
```

macOS (zsh):

```zsh
cp .env.example .env
open -e .env
```

[`.env.example`](../.env.example) explains each setting, and [Deployment](deployment.md#settings-reference) lists them
all. Never commit `.env`.

## 5. Get your data in

Start with the **Investing** tab: add your accounts (**Add account**: brokerage, Roth or traditional IRA, 401(k), HSA,
or any other label) and their trades by hand, or paste a broker's positions table into its import panel. Everything
else comes in through offline converters; [Importing data](importing-data.md) covers each source and both shells.

### File import

Keep downloads and converted files in a folder only you can open, outside the checkout:

Windows (PowerShell):

```powershell
$imports = Join-Path $env:USERPROFILE 'Holdr\imports'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
New-Item -ItemType Directory -Force -Path $imports | Out-Null
icacls $imports /inheritance:r /grant:r "*${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F'
icacls $imports /setowner "*$me"
```

macOS (zsh):

```zsh
mkdir -p ~/Holdr/imports && chmod 700 ~/Holdr ~/Holdr/imports
```

**Card activity** (American Express, Bilt and Wells Fargo CSV files; OFX, QFX or QBO files from any issuer) becomes
Holdr's redacted `holdr.card-import` JSON with `npm run holdr-card-import`. For a closed American Express statement
(the first line names the imports folder again, so the block also works in a new window):

Windows (PowerShell):

```powershell
$imports = Join-Path $env:USERPROFILE 'Holdr\imports'
npm run holdr-card-import -- amex-csv "$imports\activity.csv" --status posted --out "$imports\amex-2026-03.json"
```

macOS (zsh):

```zsh
npm run holdr-card-import -- amex-csv ~/Holdr/imports/activity.csv --status posted --out ~/Holdr/imports/amex-2026-03.json
```

Then, in Holdr: **Spending → Import redacted JSON**, choose the file and the card account (or **New card account…**),
review the preview (new rows, possible duplicates, pending charges that posted, the statement check) and choose
**Import**. The upload accepts only that JSON: raw CSV, OFX, QFX, QBO and PDF files always go through a converter
first. A card import is one database transaction, and importing the same file again adds nothing.

| Source | Converter (`npm run …`) | Imported with |
|---|---|---|
| Card CSV, OFX, QFX, QBO | `holdr-card-import` | the web upload (Spending) |
| Discover statement PDFs | `holdr-card-statement-convert` | the web upload (Spending) |
| Checking exports and statement PDFs | `holdr-checking-convert` | `npm run holdr-checking` |
| Gold and silver orders (Costco, Walmart, CollectPure) | `holdr-metals-convert` | `npm run holdr-metals` (advanced) |
| Costco receipts | `holdr-retail-convert` | `npm run holdr-retail` (advanced) |

The checking, gold and silver, and receipt importers change the database only under an authorization file you write
for one database and one payload, and take a backup first. The gold and silver and receipt workflows read capture
folders made by tools that are not part of this repository. [Importing data](importing-data.md) walks through them.

On the **Gold** page, the top card's all-time result reads "Profit or loss unavailable", and Bought and Sold say
"Recorded so far · history unverified", for now. Holdr shows that result only once it can verify that your purchase
history is complete, from a list you confirm of where you buy and sell metals, and that check is not built yet. The
period's figures, your holdings and the charts work.

### The card sync agent (experimental)

The card sync agent (`agents/card-sync`) saves your **American Express** statements without downloading and converting
files by hand. A small browser extension (Chrome or Edge on Windows, Chrome on macOS) reads the statements from your
signed-in American Express page when you click **Sync** in its panel, and hands them to a receiver that runs on this
computer, on `127.0.0.1` only. The receiver converts them into redacted `holdr.card-import` files in your private
imports folder (`%USERPROFILE%\Holdr\imports\outbox`, `~/Holdr/imports/outbox`), and you import each file with
**Spending → Import redacted JSON** as above. It never imports anything itself and never sees your bank password.

It is **experimental**: American Express U.S. dollar accounts only, posted transactions only, and it can stop working
when the bank's site changes. [Card sync agent](sync-agent.md) covers installation (the pairing key, loading the
extension, auto-start). In short, with Holdr running, in a second window (same in both shells):

```powershell
npm run agent -- pair
npm run agent
```

`npm run agent -- check` checks the setup and `npm run agent -- help` lists every command. The agent expects Holdr at
its default addresses (API `127.0.0.1:4000`, web `127.0.0.1:5173`) and data folder; pass `--data-dir` for another
folder, and `--web-url https://<machine>.<tailnet>.ts.net` when you use Holdr over HTTPS ([step 6](#6-use-holdr-from-your-phone-or-another-computer)).
For the demo, see [The demo](demo.md).

### The browser extension in `apps/extension`

`apps/extension` is a **developer preview that cannot connect as shipped**: it has no bank adapters, and it talks only
to the hardened macOS deployment's `dist` mode, which stays closed until a supported Tailscale build is pinned in the
code. It is not the card sync agent's extension. See [apps/extension/README.md](../apps/extension/README.md).

## 6. Use Holdr from your phone or another computer

Holdr never listens on your network. To open it on your own devices, use
[Tailscale Serve](https://tailscale.com/kb/1312/serve): it gives the computer that runs Holdr a private HTTPS address
that only devices signed in to your tailnet can open.

1. Install Tailscale on this computer and your phone (<https://tailscale.com/download>), sign in to the same tailnet,
   and in the [admin console](https://login.tailscale.com/admin/dns) turn on **MagicDNS** and **HTTPS certificates**.
   Note this computer's name, `<machine>.<tailnet>.ts.net`.
2. On macOS, make the `tailscale` command available. With the standalone Tailscale app (from tailscale.com), open
   **Settings → CLI integration → Show me how → Install Now**, which asks for your password and installs
   `/usr/local/bin/tailscale`. With the App Store app, or for this Terminal window only:

   ```zsh
   alias tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale
   ```

3. Start Holdr with that address (same in both shells):

   ```powershell
   npm run start:local -- --https-origin https://<machine>.<tailnet>.ts.net
   ```

4. Publish the web app to your tailnet, once; Tailscale remembers it (same in both shells):

   ```powershell
   tailscale serve --bg --https=443 http://127.0.0.1:5173
   ```

   If Windows answers "Access denied", run that line once in a PowerShell window opened as administrator.

5. Open `https://<machine>.<tailnet>.ts.net` on any of your devices, this computer included, and sign in.

With an HTTPS address, sign-in cookies are `Secure`: always use the `https://` address, not `http://127.0.0.1:5173`.
Put `HOLDR_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net` in `.env` to make it the default. To stop publishing:
`tailscale serve --https=443 off`. **Never use `tailscale funnel`**: it would put Holdr on the public internet, and
Holdr refuses Funnel requests.

## 7. Start Holdr automatically

### Windows: a Task Scheduler task

Register a task that runs `npm run start:local` whenever you sign in to Windows (as you, no administrator rights
needed). Add `-Arguments '--https-origin https://<machine>.<tailnet>.ts.net'` to pass options.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart\register-windows-task.ps1
```

It starts Holdr now and at every sign-in, in a console window of its own. The window stays empty: Holdr's output goes to
the log, `%LOCALAPPDATA%\Holdr\logs\holdr.log`.

- **Stop Holdr:** press Ctrl+C in that window, or close it. `Stop-ScheduledTask` (or **End** in Task Scheduler) ends
  only the window's `cmd.exe` and leaves Holdr running.
- **Start it again** without signing out: `Start-ScheduledTask -TaskName Holdr`
- **Remove the task:** `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart\register-windows-task.ps1 -Unregister`
  (a running Holdr keeps running until you stop it).

The task runs the `npm` that PowerShell finds when you register it. With fnm, that `npm` lasts only as long as the
window you registered from, so for auto-start install Node.js 22 with winget or the installer instead ([step 1](#windows)).

### macOS: a LaunchAgent

Install the LaunchAgent template, from the checkout, in the Terminal where `npm run start:local` works (the `sed`
command fills in that Terminal's `node`, the checkout and your home folder):

```zsh
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/Holdr
sed -e "s|__NODE__|$(command -v node)|g" -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" \
  scripts/autostart/local.holdr.start.plist.template > ~/Library/LaunchAgents/local.holdr.start.plist
plutil -lint ~/Library/LaunchAgents/local.holdr.start.plist
launchctl bootout gui/$(id -u)/local.holdr.start 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.holdr.start.plist
```

`plutil -lint` must say `OK`. The `bootout` line stops a copy that is already loaded (it prints nothing when there is
none), so the same commands also update the agent after you move the checkout or install another Node.js. If a path
contains `|`, `&` or `<`, fill in the three placeholders in a text editor instead (write `&` as `&amp;` and `<` as
`&lt;`), then run the last three lines. The log is `~/Library/Logs/Holdr/holdr.log`; settings such as
`HOLDR_PUBLIC_ORIGIN` go in `.env`. With fnm, write `$(fnm exec --using=22 node -p process.execPath)` instead of
`$(command -v node)` in the `sed` line: `command -v node` prints fnm's link, which lasts only as long as the Terminal
window.

- **Stop Holdr** (it starts again at your next login): `launchctl bootout gui/$(id -u)/local.holdr.start`
- **Start it again:** `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.holdr.start.plist`
- **Remove it:** stop it, then `rm ~/Library/LaunchAgents/local.holdr.start.plist`

The card sync agent has an auto-start of its own; with fnm, give it the same Node.js path (`-NodePath` for its Windows
task, `--node` for its LaunchAgent; see [Card sync agent](sync-agent.md)).

## 8. Back up and restore

Back up before every upgrade and before importing (same in both shells):

```powershell
npm run holdr-backup
```

It writes a new folder `backups/db/<UTC date and time>/` inside the checkout you run it from (Git ignores it), readable
by you only, with a checked copy of `finance.db` (SQLite's `integrity_check` must pass) and the other files of your
data folder, except its access tokens (`service-token`, `agent-token`), which Holdr makes anew when it starts. It is
safe to run while Holdr is running. List your backups with `Get-ChildItem backups\db` (PowerShell) or `ls backups/db`
(zsh). Copy them to a second disk or an encrypted location as well.

To restore:

1. Stop Holdr with **Ctrl+C** in its window (with auto-start on Windows, in the task's window; on macOS run
   `launchctl bootout gui/$(id -u)/local.holdr.start`). Holdr then closes its database, and the `finance.db-wal` and
   `finance.db-shm` files beside it go away.
2. From the checkout, run the block for your system, with `<UTC date and time>` replaced by the backup's folder name.
   If you use another data folder (`HOLDR_DATA_DIR`), set `data` to it; if you start Holdr with `--api-port`, change
   `4000`. The block:
   - stops, changing nothing, while Holdr's database is open (`finance.db-wal` or `finance.db-shm` exists) or something
     answers on Holdr's API port, and when the backup fails SQLite's `integrity_check`;
   - copies the backup into a new private folder next to the data folder, then swaps the two folders by renaming them,
     so your current data stays next to it as `data.before-restore.<date and time>`.

   If it says the database is open although Holdr is stopped (after a crash, or after its window was closed), start
   Holdr once, stop it with Ctrl+C, and run the block again.

   Windows (PowerShell):

   ```powershell
   & {
     $ErrorActionPreference = 'Stop'
     $data = Join-Path $env:LOCALAPPDATA 'Holdr\data'
     $backup = (Resolve-Path 'backups\db\<UTC date and time>').Path
     if ((Test-Path "$data\finance.db-wal") -or (Test-Path "$data\finance.db-shm")) { throw "Holdr's database is open (finance.db-wal or -shm exists): stop Holdr with Ctrl+C first" }
     $tcp = [Net.Sockets.TcpClient]::new(); $answers = $true
     try { $tcp.Connect('127.0.0.1', 4000) } catch { $answers = $false } finally { $tcp.Dispose() }
     if ($answers) { throw 'something answers on 127.0.0.1:4000: stop Holdr first' }
     $check = node -e "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});console.log(db.pragma('integrity_check',{simple:true}));db.close()" "$backup\finance.db"
     if ($check -ne 'ok') { throw "the backup failed its check: $check" }
     $stamp = Get-Date -Format yyyyMMddTHHmmss
     $new = "$data.restoring.$stamp"
     $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
     New-Item -ItemType Directory -Path $new | Out-Null
     icacls $new /inheritance:r /grant:r "*${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
     if ($LASTEXITCODE -ne 0) { throw 'icacls could not make the new folder private' }
     icacls $new /setowner "*$me" | Out-Null
     if ($LASTEXITCODE -ne 0) { throw 'icacls could not make you the owner of the new folder' }
     Copy-Item -Path (Join-Path $backup '*') -Destination $new
     if (Test-Path $data) { Rename-Item $data "$(Split-Path -Leaf $data).before-restore.$stamp" }
     Rename-Item $new (Split-Path -Leaf $data)
     "Restored $backup into $data"
   }
   ```

   macOS (zsh):

   ```zsh
   (
     set -euo pipefail
     data="$HOME/Library/Application Support/Holdr/data"
     backup="$PWD/backups/db/<UTC date and time>"
     if [[ -e "$data/finance.db-wal" || -e "$data/finance.db-shm" ]]; then echo "Holdr's database is open (finance.db-wal or -shm exists): stop Holdr with Ctrl+C first" >&2; exit 1; fi
     if curl --silent --noproxy '*' --max-time 3 --output /dev/null http://127.0.0.1:4000/health; then echo 'something answers on 127.0.0.1:4000: stop Holdr first' >&2; exit 1; fi
     check=$(node -e "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});console.log(db.pragma('integrity_check',{simple:true}));db.close()" "$backup/finance.db" 2>&1 || true)
     if [[ "$check" != ok ]]; then echo "the backup failed its check: $check" >&2; exit 1; fi
     stamp=$(date -u +%Y%m%dT%H%M%SZ)
     mkdir -m 700 "$data.restoring.$stamp"
     cp -p "$backup"/* "$data.restoring.$stamp/"
     chmod 600 "$data.restoring.$stamp"/*
     if [[ -e "$data" ]]; then mv "$data" "$data.before-restore.$stamp"; fi
     mv "$data.restoring.$stamp" "$data"
     echo "Restored $backup into $data"
   )
   ```

3. Start Holdr (`npm run start:local`, `Start-ScheduledTask -TaskName Holdr`, or
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.holdr.start.plist`), sign in, and check balances and
   your latest imports. Holdr makes a new `service-token` and `agent-token` as it starts; the card sync agent and the MCP
   server read the new ones by themselves. If anything is wrong, stop Holdr, rename the restored `data` folder aside and
   rename `data.before-restore.<date and time>` back to `data`.

## 9. Upgrade, or go back to an older version

**Upgrade.** Stop Holdr (Ctrl+C in its window; with auto-start, close the task's window on Windows or run
`launchctl bootout gui/$(id -u)/local.holdr.start` on macOS) and, if you use it, the card sync receiver
([Card sync agent: Update](sync-agent.md#update)). Then back up, update and start again; `npm run start:local` rebuilds
what changed (same in both shells):

```powershell
npm run holdr-backup
git switch main
git pull
npm ci
npm run start:local
```

With auto-start, use `Start-ScheduledTask -TaskName Holdr` (Windows) or
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.holdr.start.plist` (macOS) instead of the last line.
`git switch main` matters only if you went back to an older version before; otherwise you are on `main` already.
Holdr may upgrade the database when it starts, so keep the backup until you have checked the new version.

**Go back.** An older Holdr refuses a database that a newer one has upgraded, so going back needs the backup you took
before upgrading:

1. Stop Holdr and restore that backup ([step 8](#8-back-up-and-restore)).
2. Switch to the older version, here `<commit>` (from `git log --oneline`, or a release tag), and start it:

   ```powershell
   git switch --detach <commit>
   npm ci
   npm run start:local -- --rebuild
   ```

3. To return to the latest version later: `git switch main`, then upgrade as above.

## 10. Uninstall

This removes Holdr and everything it keeps on this computer: your data folder, the demo, the logs, the imports folder
(your downloads, converted files and pre-import backups) and the checkout, with the backups inside it. Copy what you
want to keep somewhere else first, such as a folder from `backups/db` in the checkout.

1. Stop Holdr (Ctrl+C in its window) and the card sync receiver, if you use it.
2. Remove what points to Holdr from elsewhere:
   - your AI clients' entries for Holdr: `copilot mcp remove holdr` (and `holdr-demo`, if you added it), or delete them
     from the files in [Connect your AI client](agents.md#connect-your-ai-client);
   - the **Holdr Card Sync** extension, with **Remove** in `chrome://extensions` or `edge://extensions`;
   - Tailscale Serve, if you published Holdr with it: `tailscale serve --https=443 off`.
3. Remove auto-start, if you set it up. Windows (PowerShell, in the checkout; run the line for each task you set up,
   Holdr's and the card sync agent's):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart\register-windows-task.ps1 -Unregister
   powershell -NoProfile -ExecutionPolicy Bypass -File agents\card-sync\install\windows\unregister-task.ps1
   ```

   macOS (zsh):

   ```zsh
   for agent in local.holdr.start local.holdr.card-sync; do
     launchctl bootout gui/$(id -u)/$agent 2>/dev/null
     rm -f ~/Library/LaunchAgents/$agent.plist
   done
   ```

4. Delete Holdr's folders. The checkout is the one from [step 2](#2-get-holdr); change its path if yours is elsewhere.

   Windows (PowerShell):

   ```powershell
   Set-Location $env:USERPROFILE
   foreach ($folder in "$env:LOCALAPPDATA\Holdr", "$env:USERPROFILE\Holdr", "$env:USERPROFILE\src\holdr") {
     if (Test-Path $folder) { Remove-Item -Recurse -Force $folder }
   }
   ```

   macOS (zsh):

   ```zsh
   cd ~ && rm -rf ~/Library/Application\ Support/Holdr ~/Library/Logs/Holdr ~/Holdr ~/src/holdr
   ```

Node.js, Git and Tailscale stay installed; remove them the way you installed them if you no longer need them.

## What runs where

| | Windows 10/11 | macOS | Linux |
|---|---|---|---|
| Demo (`npm run demo`) | ✅ | ✅² | untested |
| Your own data (`npm run start:local`) | ✅ | ✅² | untested |
| Development (`npm run dev`) | ✅ | ✅ | untested |
| Your other devices over private HTTPS (Tailscale Serve) | ✅ | ✅ | untested |
| Backups (`npm run holdr-backup`) | ✅ | ✅ | untested |
| Card, statement and checking converters and the checking importer | ✅ | ✅ | untested |
| Gold and silver, and Costco receipts | advanced¹ | advanced¹ | untested |
| MCP server for AI agents (`npm run mcp`, [AI agents](agents.md)) | ✅ | ✅² | untested |
| Card sync agent (American Express) | experimental | experimental | — |
| Hardened deployment (`local`/`dist` release modes) | — | advanced | — |
| Browser extension (`apps/extension`) | not usable as shipped | not usable as shipped | — |

¹ They read capture folders made by tools that are not part of this repository, and some of their read-only steps need
a setting outside the hardened deployment; on macOS they also check folder permissions with Holdr's native path
checker. See [Importing data](importing-data.md#owner-only-folders).

² The launcher (which the demo uses too) and the MCP server have so far run end to end on Windows; on macOS, their
folders, permissions and paths are covered by unit tests.

The hardened macOS deployment (immutable web releases, lifecycle locks, a pinned Node.js) is for advanced users:
[Deployment](deployment.md#d-advanced-hardened-macos-deployment).

## Where your data lives

| | Windows | macOS | Linux |
|---|---|---|---|
| Your data (`npm run start:local`, `npm run holdr-*`) | `%LOCALAPPDATA%\Holdr\data` | `~/Library/Application Support/Holdr/data` | `~/.local/share/holdr/data` |
| The demo (`npm run demo`) | `%LOCALAPPDATA%\Holdr\holdr-demo\data` | `~/Library/Application Support/Holdr/holdr-demo/data` | `~/.local/share/holdr/holdr-demo/data` |
| Development (`npm run dev`) | `apps\api\data` in the checkout | `apps/api/data` in the checkout | `apps/api/data` |
| Imports you download and convert | `%USERPROFILE%\Holdr\imports` (suggested) | `~/Holdr/imports` (suggested) | your choice |
| Backups | `backups\db` in the checkout | `backups/db` in the checkout | `backups/db` |
| Auto-start log | `%LOCALAPPDATA%\Holdr\logs\holdr.log` | `~/Library/Logs/Holdr/holdr.log` | — |

Set `HOLDR_DATA_DIR` (in the environment or `.env`), or pass `--data-dir`, to use another data folder. The data folder
holds `finance.db` (your SQLite database, with your password hashes) and the access tokens the API creates for scripts
and agents on this computer, `service-token` and `agent-token` ([AI agents](agents.md)). Every data folder Holdr creates
is readable by your account only: on Windows an access list for you and SYSTEM, on macOS and Linux mode `0700`. Keep it,
the backups, the imports folder and `.env` private.

What leaves your computer: only requests for public market data, the quotes and price history of the ticker symbols you
hold (from Nasdaq, CNBC, Stooq, CoinGecko, Hyperliquid and Cboe) and, if you turn them on (`HOLDR_METALS_PRICES=1`), gold
and silver spot prices. They carry a symbol and a date range, never an account, an amount or your identity. The demo
runs offline, with synthetic prices. One advanced command is the exception: the Amazon product-thumbnail backfill
(`apps/api/src/cli/amazonImagesMain.ts`, no npm script) downloads product images from Amazon's image server, and only
when you run it with a GO file. Holdr never asks for your bank or broker passwords and has no telemetry; the
repository's build scripts also turn Turborepo's telemetry off. If you connect a cloud AI client to the MCP server, what
it reads goes to that AI provider.

## Troubleshooting

| Problem | What to do |
|---|---|
| "running scripts is disabled on this system" (Windows) | Windows PowerShell 5.1 blocks `npm`: run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once, or type `npm.cmd` ([step 1](#windows)). |
| "Holdr needs Node.js 22 (22.3 or a later 22.x release)" | Install Node.js 22 ([step 1](#1-install-nodejs-22-and-git)), open a new window, and run `npm ci` again. winget's `OpenJS.NodeJS.LTS` is Node.js 26. |
| `npm ci` compiles `better-sqlite3` (`node-gyp`, `gyp ERR!`) | Check `node --version` (it must be 22). Only if you really need to compile, install the [build tools](#only-if-npm-ci-compiles-the-sqlite-module). |
| `npm ci` fails with `EPERM`, `EBUSY` or "operation not permitted" (Windows) | Holdr or the card sync receiver still uses files in `node_modules`: stop both, then run `npm ci` again. |
| `xcrun: error: invalid active developer path` (macOS, often after a macOS update) | Run `xcode-select --install` again. |
| `the web port 5173 is in use` | Holdr (or another program) is already running. Stop it, or choose `--web-port`/`--api-port`. |
| The page asks you to sign in but no user exists | Run `npm run holdr-user -- add <name>`, with the same `HOLDR_DATA_DIR` if you set one. |
| You forgot your password | `npm run holdr-user -- passwd <name>` sets a new one (`npm run holdr-user -- list` shows the names). |
| `holdr-user: unexpected argument …` or `standard input is not a terminal` when piping a password in PowerShell | Pipe into `npm.cmd`, not `npm` ([step 3](#3-create-your-sign-in)). |
| `Blocked request. This host (…) is not allowed` | You opened Holdr under a name it does not know. Use `http://127.0.0.1:5173`, or start it with `--https-origin` for your Tailscale address. |
| `Cross-origin request rejected` | The page and the API disagree about the address: open exactly the address `start:local` printed. |
| Sign-in works on `https://…ts.net` but not on `http://127.0.0.1` | Expected with an HTTPS address: use the `https://` one everywhere. |
| Opening the demo signed you out of your own Holdr | Open the demo at `http://localhost:5174`, as it prints, and your own Holdr at `http://127.0.0.1:5173`. See [The demo](demo.md). |
| `zsh: command not found: tailscale` (macOS) | With the standalone Tailscale app, install the command from its **Settings → CLI integration → Show me how → Install Now**; with the App Store app, use the `alias` in [step 6](#6-use-holdr-from-your-phone-or-another-computer). |
| `tailscale serve` says "Access denied" (Windows) | Run it once in a PowerShell window opened as administrator. |
| Holdr does not start at sign-in | Read the auto-start log ([Where your data lives](#where-your-data-lives)). Windows: `Get-ScheduledTaskInfo -TaskName Holdr` shows the last result; with fnm, see [step 7](#7-start-holdr-automatically). macOS: `launchctl print gui/$(id -u)/local.holdr.start \| head -n 20`; keep `node` allowed under **System Settings → General → Login Items & Extensions**, and keep the checkout out of Documents, Desktop, Downloads and iCloud Drive, which a LaunchAgent cannot read without a privacy prompt. |
| `Bootstrap failed: 5: Input/output error` (macOS) | The LaunchAgent is loaded already: run `launchctl bootout gui/$(id -u)/local.holdr.start`, wait a moment, then `launchctl bootstrap` again. |
| `Holdr's database is open (finance.db-wal or -shm exists)` when you restore | Stop Holdr with Ctrl+C. If it is not running (it crashed, or its window was closed), start it once, stop it with Ctrl+C, and restore again ([step 8](#8-back-up-and-restore)). |
| `a hardened deployment configuration is in use` | This computer has a `holdr.conf` for the hardened macOS deployment (or `HOLDR_CONFIG` is set): use that deployment's start script, or move the file away. |
| `E0I_BACKUP_PERMS` | A `backups` folder exists that others can open. Move it away and run `npm run holdr-backup` again. |
| Anything else | [Deployment → Troubleshooting](deployment.md#troubleshooting) lists every `E0I_*` error. Still stuck? See [Getting help](../README.md#getting-help). |
