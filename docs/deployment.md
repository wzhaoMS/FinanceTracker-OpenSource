# Deployment

Holdr is self-hosted software for one person or one household. This page describes the four ways to run it, the
settings, backups, upgrades and rollback, and what each error means. Every command runs from the repository folder;
where Windows PowerShell and macOS zsh differ, both are shown.

## Choose a setup

| | A. Development | B. Single computer | C. Private HTTPS for your devices | D. Advanced: hardened macOS |
|---|---|---|---|---|
| Start with | `npm run dev` | `npm run start:local` | `npm run start:local -- --https-origin …` and `tailscale serve` | `scripts/start-finance-mac.sh`, or the compiled API under `holdr.conf` |
| Windows | ✅ | ✅ | ✅ | — |
| macOS | ✅ | ✅ | ✅ | ✅ |
| Linux | untested | untested | untested | — |
| Web app | Vite dev server, hot reload | the built app (`vite preview`) | the built app | immutable, hash-checked web release served by the API |
| Data folder | `apps/api/data` (or `HOLDR_DATA_DIR`) | per-user folder (below) | per-user folder | `HOLDR_DATA_DIR` in `holdr.conf` |
| Who can open it | this computer | this computer | your devices on your tailnet | this computer (`local`) or your tailnet (`dist`) |

The per-user data folder is `%LOCALAPPDATA%\Holdr\data` on Windows, `~/Library/Application Support/Holdr/data` on
macOS and `~/.local/share/holdr/data` on Linux. Nothing listens on your network in any setup: the API and the web
server bind `127.0.0.1` (any other `HOLDR_HOST` stops the API), and other devices come in only through Tailscale
Serve. Holdr has no LAN mode (the old ones were removed, and their settings stop it with `E0I_LAN_REMOVED`), and there is
no supported public-internet or cloud deployment.

## Requirements and preparation

- Node.js 22, release 22.3 or later, with npm, and Git. Node.js 24 and 26 are not supported yet (the SQLite module has
  no prebuilt binaries for them), and setup D's `dist` mode needs exactly 22.23.3. [Getting started](getting-started.md#1-install-nodejs-22-and-git)
  has the install commands for Windows and macOS.
- `npm ci` installs a prebuilt `better-sqlite3`; only when none matches does it compile one, which needs Python 3 and
  the Visual Studio Build Tools ("Desktop development with C++") on Windows or the Xcode Command Line Tools
  (`xcode-select --install`) on macOS.
- Windows: the commands are for PowerShell. Windows PowerShell 5.1 blocks the `npm` script under its default execution
  policy; run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once, or type `npm.cmd` instead of
  `npm`. PowerShell 7 needs neither.

`<repository-url>` is the HTTPS address under **Code** on the repository's GitHub page. Clone into a folder of your own
(`src` below), not straight into your home folder: the private imports folder of the
[import guide](importing-data.md#owner-only-folders) is `Holdr` there, and on Windows and macOS `holdr` and `Holdr` name
the same folder.

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

`npm ci` also builds `packages/shared` (its `prepare` step); the API, the web app and every `npm run holdr-*` command
load it from `packages/shared/dist`. After changing `packages/shared` yourself, rebuild it with
`npm run build --workspace @finance-tracker/shared` (`npm run start:local` does this for you when the sources are newer).

## A. Development

```powershell
npm run holdr-user -- add <username> --data-dir apps/api/data
npm run dev
```

The same two commands work in PowerShell and zsh. `npm run dev` starts the API (`tsx watch`, port 4000) and the Vite
dev server (port 5173, hot reload) on `127.0.0.1`; open <http://127.0.0.1:5173>. Development data lives in
`apps/api/data` (Git ignores it), which is why the user is created there. `npm run dev` reads the process environment
only, not `.env`; to use another folder, set `HOLDR_DATA_DIR` for both commands:

Windows (PowerShell):

```powershell
$env:HOLDR_DATA_DIR = Join-Path $env:USERPROFILE 'HoldrDev\data'
npm run holdr-user -- add <username>
npm run dev
```

macOS (zsh):

```zsh
export HOLDR_DATA_DIR="$HOME/HoldrDev/data"
npm run holdr-user -- add <username>
npm run dev
```

The `npm run holdr-*` commands that open the data folder (`holdr-user`, `holdr-backup` and the importers) default to the
per-user folder of setup B, not to `apps/api/data`. To back up development data, name its folder:
`$env:HOLDR_DATA_DIR = "$PWD\apps\api\data"; npm run holdr-backup; Remove-Item Env:HOLDR_DATA_DIR` in PowerShell,
`HOLDR_DATA_DIR="$PWD/apps/api/data" npm run holdr-backup` in zsh. A backup of a folder that does not exist says
"nothing to back up", and one without a `finance.db` says so too.

## B. Single computer

```powershell
npm run holdr-user -- add <username>
npm run start:local
```

The same commands work in PowerShell and zsh. `npm run holdr-user` and `npm run start:local` both use the per-user data
folder (or `HOLDR_DATA_DIR` from the environment or `.env`; `holdr-user` also takes `--data-dir`), and whichever runs
first creates it, readable by you only. To create users from a script, pipe the password in with `--password-stdin`
(in PowerShell into `npm.cmd`, which keeps the `--`: `$password | npm.cmd run holdr-user -- add <username> --password-stdin`,
after `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)` in Windows PowerShell 5.1 so that characters outside
ASCII survive the pipe; in zsh `printf '%s\n' "$password" | npm run holdr-user -- add <username> --password-stdin`).
`start:local`:

1. reads `.env` (variables already set win);
2. creates the data folder if it is missing, readable by you only (on Windows an ACL for you and SYSTEM, set with
   `icacls`; elsewhere mode `0700`), and makes an existing one readable by you only, or refuses one that belongs to
   another account;
3. builds `packages/shared` and the web app when their build is missing or older than the sources (`--rebuild` forces
   it);
4. starts the API on `127.0.0.1:4000` and serves the built web app with `vite preview` on `127.0.0.1:5173`, which
   forwards API calls to the API, refuses other host names and refuses Tailscale Funnel requests;
5. prints the address, and on Ctrl+C (or when the window closes) stops both servers.

Options: `--data-dir`, `--api-port`, `--web-port`, `--https-origin` (setup C), `--dev` (Vite dev server instead of the
build), `--rebuild`, `--help`. `npm run demo` starts the same stack on ports 4001/5174 (open <http://localhost:5174>)
with the synthetic demo data in its own folder; it reads no `.env`, runs offline with synthetic prices, and its options
(`--reset`, `--keep-data`, `--password-stdin`) are in the [demo guide](demo.md).

`start:local` refuses to run when a hardened deployment's configuration is present (`HOLDR_CONFIG`, or
`~/Library/Application Support/Holdr/holdr.conf`): that machine runs setup D.

To start Holdr at sign-in (a Task Scheduler task on Windows, a LaunchAgent on macOS), see
[Getting started](getting-started.md#7-start-holdr-automatically).

## C. Private HTTPS for your devices

[Tailscale Serve](https://tailscale.com/kb/1312/serve) publishes the web app to your tailnet over HTTPS with a
certificate for `https://<machine>.<tailnet>.ts.net`; only devices signed in to your tailnet can open it. Holdr itself
keeps listening on `127.0.0.1`.

1. Install Tailscale on the computer that runs Holdr and on your other devices, and sign in to the same tailnet. In the
   [admin console](https://login.tailscale.com/admin/dns) enable **MagicDNS** and **HTTPS certificates**. Leave Funnel
   off.
2. Find the computer's address. On macOS the command is `/Applications/Tailscale.app/Contents/MacOS/Tailscale` unless
   you installed the `tailscale` command: with the standalone Tailscale app, **Settings → CLI integration → Show me how
   → Install Now** (it asks for your password and installs `/usr/local/bin/tailscale`); the App Store app has no
   installer, so use that full path or an `alias` ([Getting started, step 6](getting-started.md#6-use-holdr-from-your-phone-or-another-computer)).

   Windows (PowerShell):

   ```powershell
   (tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
   ```

   macOS (zsh):

   ```zsh
   tailscale status --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,'')))"
   ```

3. Start Holdr with that origin (or put `HOLDR_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net` in `.env`):

   ```powershell
   npm run start:local -- --https-origin https://<machine>.<tailnet>.ts.net
   ```

4. Publish the web port, once; Tailscale keeps it across restarts:

   ```powershell
   tailscale serve --bg --https=443 http://127.0.0.1:5173
   tailscale serve status
   ```

   Steps 3 and 4 are the same in PowerShell and zsh. If Windows answers "Access denied", run the `tailscale serve`
   line once in a PowerShell opened as administrator.

5. Open `https://<machine>.<tailnet>.ts.net` on every device, this computer included, and sign in.

With an https origin the API issues `Secure` `__Host-` session cookies, so sign-in works only on the https address, and
sessions issued over plain HTTP before are ended. Stop publishing with `tailscale serve --https=443 off`. Never run
`tailscale funnel`: both the web server and the API refuse Funnel requests.

## D. Advanced: hardened macOS deployment

The release modes `local` and `dist` run the compiled API under a private configuration file, `holdr.conf`, with
immutable hash-checked web releases, a lifecycle lock protocol for upgrades, and in `dist` a Unix socket for Tailscale
Serve with attested ingress. They exist on macOS only: the lifecycle protocol takes macOS `O_SHLOCK`/`O_EXLOCK` file
locks, so on other systems the API and every writer command refuse with `E0I_PLATFORM` once a control directory is
configured. Setups B and C cover the same day-to-day use without these parts.

Setup D's start script, upgrade kit and lifecycle commands find the live checkout at `$HOLDR_ROOT/FinanceTracker`
(default `~/Holdr/FinanceTracker`), so for this setup clone it there under that name instead of `holdr`:
`git clone <repository-url> ~/Holdr/FinanceTracker`.

| Mode | Who can open it | Status |
|---|---|---|
| `local` | this computer: `http://127.0.0.1:8888` | supported; the API logs a `BREAK-GLASS` notice every hour because the mode has no verified ingress |
| `dist` | your tailnet, through Tailscale Serve to a Unix socket | implemented but **closed as shipped** (see below) |

### D1. `local`

1. Build an immutable web release from the committed checkout you will run:

   ```zsh
   C=$(git rev-parse HEAD)
   npm run build:release --workspace @finance-tracker/web -- --commit "$C"
   ```

   It prints `RELEASE digest=<D> dir=<directory> files=<n> bytes=<n>` and writes `apps/web/releases/<first 12 hex of D>/`
   with `public/` and `manifest.json`. Leave that directory in place; the API finds it from the digest.
   `npm run verify:release --workspace @finance-tracker/web -- --dir <directory> --digest <D>` checks it again.

2. Create `~/Library/Application Support/Holdr/holdr.conf` (another absolute path works if you export
   `HOLDR_CONFIG=<path>` for every command below): `KEY=VALUE` lines with no spaces around `=` and no quotes (a value
   may contain spaces, as in `Application Support`), owned by you, mode `0600`, absolute paths without symbolic links.
   With a `holdr.conf` in use, the `npm run holdr-*` commands read it and never `.env`.

   ```text
   HOLDR_WEB_MODE=local
   HOLDR_WEB_RELEASE=<D>
   HOLDR_DATA_DIR=/Users/<you>/Library/Application Support/Holdr/data
   HOLDR_CONTROL_DIR=/Users/<you>/Library/Application Support/Holdr/control
   HOLDR_DEVICE_API=0
   ```

   `HOLDR_INGRESS_PORT` (default `8888`) changes the browser port. Keep the data and control directories outside the
   repository.

3. Create the control directory and the first user, and run the read-only checks:

   ```zsh
   chmod 600 "$HOME/Library/Application Support/Holdr/holdr.conf"
   npm run holdr-recovery -- init
   npm run holdr-user -- add <username>
   npm run holdr-ingress -- preflight
   ```

4. Build and start the compiled API, and keep it running under a supervisor such as a LaunchAgent:

   ```zsh
   npm run build
   NODE_ENV=production npm start --workspace @finance-tracker/api
   ```

   `local` and `dist` refuse to start without `NODE_ENV=production`. The API answers
   `GET http://127.0.0.1:4000/health` and serves the release on `http://127.0.0.1:8888`.

**The bundled start script.** `scripts/start-finance-mac.sh [--preflight | --stop]` starts, checks and stops the same
modes, rotates logs into `~/holdr-logs`, and manages Tailscale Serve for `dist`. It expects the live checkout at
`$HOLDR_ROOT/FinanceTracker` (default `~/Holdr/FinanceTracker`) and takes Node from `HOLDR_NODE`, else the `node` on
`PATH`. `scripts/holdr-boot.sh` runs it at login from `~/bin/start-finance-mac.sh`. The script was written for its
original author's machine and is **advanced and unsupported**: outside the `vite` mode it also starts a broker sidecar,
`portfolio-bridge`, which is **not part of this repository**, and refuses to start unless that sidecar answers
`GET /health` on `127.0.0.1:3003` from one of two places, each with its own Python:
`$HOLDR_BRIDGE_RUNTIME/portfolio-bridge/server.py` with `$HOLDR_BRIDGE_RUNTIME/.venv313/bin/python` (the runtime
directory defaults to `~/Library/Application Support/Holdr`), or else `$HOLDR_ROOT/apps/portfolio-bridge/server.py` with
`$HOLDR_ROOT/.venv313/bin/python` (default `~/Holdr`, beside the checkout, not inside it). Without such a sidecar,
start the API yourself as in step 4, under a LaunchAgent of your own.

### D2. `dist` (Tailscale Serve to a Unix socket)

Tailscale Serve terminates HTTPS on `https://<machine>.<tailnet>.ts.net` and forwards to a Unix socket owned by the API,
which admits a request only while its Serve attestation is verified and otherwise answers `503`. As shipped, **no
Tailscale build is approved** (`SUPPORTED_TAILSCALE` in `apps/api/src/ingress/attestation.ts` is empty), so every request
on the socket is refused with `tailscale-version-unsupported`; enabling `dist` needs a reviewed code change that pins
the exact output of `tailscale version` on your host.

Requirements:

- Node.js exactly `22.23.3`, the runtime in `VERIFIED_RUNTIMES` (others refuse with `E0I_RUNTIME_UNVERIFIED`);
- Tailscale signed in, with MagicDNS and HTTPS certificates on and Funnel off;
- the native path checker, built from the commit you run (needs the Xcode Command Line Tools):

  ```zsh
  npm run build:native --workspace @finance-tracker/api -- --commit "$(git rev-parse HEAD)"
  ```

  It prints `NATIVE commit=<commit> manifest=<digest> ...`; those are `HOLDR_NATIVE_COMMIT` and
  `HOLDR_NATIVE_MANIFEST`;
- a socket path of at most 100 bytes, in a directory only you can open.

`holdr.conf` for `dist` (written for you by `set-mode` below):

```text
HOLDR_WEB_MODE=dist
HOLDR_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net
HOLDR_WEB_RELEASE=<D>
HOLDR_DATA_DIR=/Users/<you>/Library/Application Support/Holdr/data
HOLDR_CONTROL_DIR=/Users/<you>/Library/Application Support/Holdr/control
HOLDR_SERVE_SOCKET=/Users/<you>/Library/Application Support/Holdr/run/ingress.sock
HOLDR_TAILSCALE_CLI=<absolute path of the tailscale command>
HOLDR_DEVICE_API=0
HOLDR_NATIVE_COMMIT=<commit printed by build:native>
HOLDR_NATIVE_MANIFEST=<digest printed by build:native>
```

From a working `local` setup:

1. Add `HOLDR_TAILSCALE_CLI`, `HOLDR_NATIVE_COMMIT` and `HOLDR_NATIVE_MANIFEST` to `holdr.conf`; `set-mode` keeps these
   keys across modes but never invents them.
2. Switch the configuration, stop the API, and clear any old Serve target:

   ```zsh
   npm run holdr-ingress -- set-mode dist --origin "https://<machine>.<tailnet>.ts.net" \
     --socket "$HOME/Library/Application Support/Holdr/run/ingress.sock"
   tailscale serve --https=443 off
   ```

3. Start the API (`NODE_ENV=production npm start --workspace @finance-tracker/api`). Once it has created the socket,
   publish exactly one Serve target and run the checks:

   ```zsh
   tailscale serve --bg --https=443 "unix:$HOME/Library/Application Support/Holdr/run/ingress.sock"
   tailscale serve status --json
   npm run holdr-ingress -- preflight
   ```

`set-mode` writes the complete key set of the target mode, validates it and replaces `holdr.conf` atomically; it takes
no lock and restarts nothing. Leaving `dist` saves that file as `holdr.conf.dist`, from which a later `set-mode dist`
restores the origin, socket and device setting. `npm run holdr-ingress -- set-mode local` returns to D1.

**The browser extension** (`apps/extension`) is a developer preview that **cannot connect as shipped**: it has no bank
adapters, and the only Holdr it talks to is this `dist` mode with `HOLDR_DEVICE_API=1` in `holdr.conf`, which stays
closed until a supported Tailscale build is pinned (above). Its production build is tied to the exact `dist` origin;
see [apps/extension/README.md](../apps/extension/README.md). The supported ways to get data in are file import and the
[card sync agent](sync-agent.md).

**Metals and retail commands on macOS** check output and input folders through the native path checker above, with
the pins from `holdr.conf`. See [Importing data](importing-data.md#owner-only-folders).

## Settings reference

`start:local` and the `npm run holdr-*` commands that open the data folder (`holdr-user`, `holdr-backup` and the
importers) read `.env` from the repository checkout (variables already set win). Nothing else reads it: not the demo,
which uses only its own settings; not the offline converters (`holdr-card-import`, `holdr-*-convert`); not
`npm run dev`, which reads only the environment; not the card sync agent or the MCP server (`npm run agent`,
`npm run mcp`: options or environment variables, see [Card sync agent](sync-agent.md) and [AI agents](agents.md)); and
not setup D's commands. Setup D reads `holdr.conf` (keys marked *conf* may also be set there, and must then not differ
in the environment), and with a `holdr.conf` in use the `holdr-*` commands skip `.env`. Never commit `.env` or
`holdr.conf`.

| Setting | Read by | Default | Notes |
|---|---|---|---|
| `HOLDR_DATA_DIR` | API, `holdr-*` commands (*conf*) | per-user folder with `start:local` and the `holdr-*` commands that open the data folder; `apps/api/data` with `npm run dev`, and with setup D's `holdr-ingress`, `holdr-recovery` and `holdr-lifecycle` when neither `holdr.conf` nor the environment sets it | absolute path; Windows paths allowed outside setup D |
| `PORT` | API | `4000` | `start:local -- --api-port` sets it |
| `HOLDR_HOST` | API | `127.0.0.1` | loopback only: `127.0.0.1`, `::1` or `localhost` (setup D: `127.0.0.1`); anything else stops the API (`E0I_BIND`). `start:local` always uses `127.0.0.1` |
| `WEB_ORIGIN` | API (A, B, C) | `http://localhost:5173,http://127.0.0.1:5173` | browser origins allowed to make changes, comma-separated. `start:local` always allows its own web address and adds these; with `npm run dev` this list replaces the default, so keep `http://127.0.0.1:5173,http://localhost:5173` in it |
| `HOLDR_PUBLIC_ORIGIN` | API, web server (*conf*) | none | `https://<machine>.<tailnet>.ts.net`; switches cookies to `Secure` |
| `HOLDR_API_TARGET` | web server | `http://127.0.0.1:4000` | where the web server forwards API calls; `start:local` sets it |
| `SNAPSHOTS_ENABLED`, `SNAPSHOT_INTERVAL_MS` | API | on outside `NODE_ENV=production`, every 5 minutes | `0` turns portfolio snapshots (the 1-day chart) off |
| `HOLDR_MARKET_DATA` | API | `live` | `live` asks the public market-data providers; `stored` answers quotes, price history and the Gold page's values from the daily closes already in the database, labelled synthetic, and asks no provider (the demo runs so). Any other value stops the API |
| `HOLDR_INTRADAY_PRICES` | API | on | `0` turns the 1-day and 1-week intraday price requests off |
| `HOLDR_METALS_PRICES` | API (*conf*) | off | `1` fetches gold and silver spot closes for the Gold page |
| `HOLDR_METALS_FUNGIBLE`, `HOLDR_METALS_ESTIMATE_UNMATCHED` | API (*conf*) | none | Gold page assignment and estimate policies, e.g. `XAU` or `XAU,XAG` |
| `HOLDR_SERVICE_TOKEN_FILE` | API | `<data folder>/service-token` | the loopback service token for local scripts |
| `HOLDR_TAILNET_HOSTNAME`, `HOLDR_TAILNET_ADDRESSES` | web server | none | extra host names and tailnet addresses the web server accepts |
| `HOLDR_CONFIG` | API, every command | `~/Library/Application Support/Holdr/holdr.conf` (macOS) | setup D only |
| `HOLDR_WEB_MODE` | API (*conf*) | `vite` | `vite`, `local` or `dist` (setup D) |
| `HOLDR_WEB_RELEASE` | API (*conf*) | none | digest of the web release (setup D) |
| `HOLDR_CONTROL_DIR` | API, commands (*conf*) | none | lifecycle and recovery state (setup D); created by `holdr-recovery init` |
| `HOLDR_INGRESS_PORT` | API (*conf*) | `8888` | browser port in `local` mode |
| `HOLDR_SERVE_SOCKET`, `HOLDR_TAILSCALE_CLI` | API (*conf*) | none | `dist` mode |
| `HOLDR_NATIVE_COMMIT`, `HOLDR_NATIVE_MANIFEST` | API, metals and retail commands on macOS (*conf*) | none | pins of the native path checker |
| `HOLDR_DEVICE_API` | API (*conf*) | `0` | `1` enables the card-sync device API (`dist` only) |
| `HOLDR_ROOT`, `HOLDR_NODE` | macOS host scripts | `~/Holdr`; the `node` on `PATH` | live tree parent and Node executable for `scripts/*.sh` |
| `HOLDR_EXTENSION_ORIGIN` | extension production build | none (required) | the exact `dist` origin compiled into the extension |
| `NODE_ENV` | API | unset | `production` is required for `local` and `dist` |

## Backup and restore

`npm run holdr-backup` (same in PowerShell and zsh) writes a new folder `backups/db/<UTC date and time>/` in the
checkout that runs it, holding a copy of `finance.db` made with SQLite's `VACUUM INTO` and checked with
`PRAGMA integrity_check`, plus the other regular files of the data folder except the access tokens (`service-token`,
`agent-token`): the API makes new ones when they are missing, so a restore never brings back a token you rotated. It
can run while Holdr runs; in setup D it takes the lifecycle lease and refuses during maintenance. The `backups` folders
are private: mode `0700` on macOS and Linux, and on Windows an ACL for you and SYSTEM, owned by you. An existing
`backups` folder that others can read is refused (`E0I_BACKUP_PERMS`), never repaired. `--tree <checkout>` writes into
another checkout's `backups`. Copy backups to a second disk or encrypted storage too; Git ignores `backups/`.

There is no restore command. Restore offline, as the account that runs Holdr, with one complete backup folder, from the
repository checkout that made the backup (the check loads `better-sqlite3` from it):

1. Stop Holdr with Ctrl+C in its window (with auto-start: in the task's window on Windows, or
   `launchctl bootout gui/$(id -u)/local.holdr.start` on macOS; in setup D, `scripts/start-finance-mac.sh --stop` or
   your own supervisor). A clean stop closes the database, which removes `finance.db-wal` and `finance.db-shm`.
2. Run the block for your system, with `<UTC date and time>` replaced by the backup's folder name. Set `data` to your
   data folder if it is not the default (your `HOLDR_DATA_DIR`; in setup D, the `HOLDR_DATA_DIR` in `holdr.conf`), and
   change `4000` if the API uses another port. The block stops, changing nothing, while the database is open
   (`finance.db-wal` or `finance.db-shm` exists) or something answers on the API port, and when the backup fails
   `PRAGMA integrity_check`. Otherwise it copies the backup into a new private folder next to the data folder and swaps
   the two folders by renaming them, so the current data stays as `data.before-restore.<date and time>`. If it says the
   database is open although Holdr is stopped (after a crash, or a closed window), start Holdr once, stop it with
   Ctrl+C, and run the block again.

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

3. Start Holdr; check sign-in, balances and your latest imports; take a new backup. The API makes new access tokens as it
   starts, and the card sync agent and the MCP server read the new ones by themselves.

If the restored data is wrong, stop Holdr, rename the restored folder aside and rename `data.before-restore.*` back. In
setup D, after a restore run `npm run holdr-recovery -- reinit` if the API reports an incomplete control directory.

## Upgrade

Setups B and C, in PowerShell or zsh. First stop Holdr (Ctrl+C in its window; with auto-start, close the task's window
on Windows or run `launchctl bootout gui/$(id -u)/local.holdr.start` on macOS) and, if you use it, the card sync
receiver ([Card sync agent: Update](sync-agent.md#update)): on Windows, `npm ci` cannot replace files they still use.

```powershell
npm run holdr-backup
git switch main
git pull
npm ci
npm run start:local
```

With auto-start, start Holdr again with `Start-ScheduledTask -TaskName Holdr` (Windows) or
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.holdr.start.plist` (macOS) instead of the last line.
`git switch main` matters only if you went back to an older version before (`git pull` fails on a detached checkout).
`start:local` rebuilds `packages/shared` and the web app because their sources changed; the API may migrate the database
forward when it starts. Keep the pre-upgrade backup until you have checked the new version.

Setup A keeps its data in `apps/api/data` (or your `HOLDR_DATA_DIR`), so stop `npm run dev`, back up that folder, then
update the same way and start `npm run dev` again:

Windows (PowerShell):

```powershell
$env:HOLDR_DATA_DIR = "$PWD\apps\api\data"; npm run holdr-backup; Remove-Item Env:HOLDR_DATA_DIR
git switch main
git pull
npm ci
npm run dev
```

macOS (zsh):

```zsh
HOLDR_DATA_DIR="$PWD/apps/api/data" npm run holdr-backup
git switch main
git pull
npm ci
npm run dev
```

Setup D:

1. `npm run holdr-backup`, and keep that backup until the new version is verified.
2. Stop the API.
3. `git fetch`, `git switch --detach <new commit>`, `npm ci`, `npm run build`.
4. Build the new web release (D1 step 1) and note its digest `<D2>`.
5. `npm run holdr-ingress -- set-mode local --release <D2>` (or `set-mode dist --release <D2>`). In `dist`, rebuild the
   native path checker and update its two pins whenever its source changed.
6. `npm run holdr-ingress -- preflight`, then start the API and check `/health`, sign-in, balances and imports.

## Rollback

A newer Holdr may have migrated the database, and an older one refuses a newer database, so going back needs the
backup taken before the upgrade:

1. Stop Holdr.
2. Restore the pre-upgrade backup as above.
3. `git switch --detach <previous commit>` and `npm ci`, then `npm run start:local -- --rebuild` (setups B and C),
   `npm run dev` (setup A), or `npm run build` (setup D). To return to the latest version later, `git switch main`
   and upgrade as above.
4. Setup D only: `npm run holdr-ingress -- set-mode local --release <previous digest>` (rebuild that release from the
   previous commit if its directory is gone), then `npm run holdr-ingress -- preflight`.
5. Start Holdr and check it.

The staged upgrade kit of setup D (`scripts/deploy-apply.sh`, `scripts/rollback-kit.sh` and
`npm run holdr-lifecycle -- exclusive`) automates these steps with hash-checked archives and a reversible snapshot; see
[Staged upgrades of the hardened deployment](e0i-ingress.md) (advanced, unsupported). It copies the staging tree's web
release, native build and `packages/shared/dist` into the live tree, so build all three in the staging tree first.

## Troubleshooting

| Message | Meaning and fix |
|---|---|
| `the API port 4000 is in use` / `the web port 5173 is in use` | Holdr or another program already listens there. Stop it, or choose `--api-port` / `--web-port`. |
| `a hardened deployment configuration is in use` | `HOLDR_CONFIG` is set or `~/Library/Application Support/Holdr/holdr.conf` exists. Use setup D's start script, or unset `HOLDR_CONFIG` / move the file. |
| `Holdr needs Node.js 22 (22.3 or a later 22.x release)` | Install Node.js 22 ([Getting started, step 1](getting-started.md#1-install-nodejs-22-and-git)), open a new window, and run `npm ci` again. |
| `npm ci` fails with `EPERM`, `EBUSY` or "operation not permitted" (Windows) | Holdr or the card sync receiver still uses files in `node_modules`: stop both, then run `npm ci` again. |
| `Blocked request. This host ("…") is not allowed` (Vite) | The page was opened under a host name the web server does not know. Use `http://127.0.0.1:<port>`, or give your Tailscale address with `--https-origin` / `HOLDR_PUBLIC_ORIGIN` (other names: `HOLDR_TAILNET_HOSTNAME`). |
| `Cross-origin request rejected` / `Origin header required` (API, 403) | A change came from an origin the API does not allow. Open exactly the address `start:local` printed; with HTTPS, the `https://` one. Extra origins go in `WEB_ORIGIN`. |
| `Holdr is not available over Tailscale Funnel` (403) | The request came through Funnel. Turn Funnel off (`tailscale funnel --https=443 off`) and use `tailscale serve`. |
| `data routes answer 503 until you run npm run holdr-user -- add <username>` | No user exists in this data folder. Create one with the same `HOLDR_DATA_DIR`. |
| `holdr-user: unexpected argument …` or `standard input is not a terminal` after piping a password in PowerShell | PowerShell's `npm` drops the `--` when input is piped. Pipe into `npm.cmd` instead. |
| `E0I_PLATFORM` | A lifecycle feature of setup D ran on Windows or Linux, usually because `HOLDR_CONTROL_DIR` or a `holdr.conf` is set. Unset them, or use macOS for setup D. |
| `E0I_BIND` | `HOLDR_HOST` names an address other than loopback (`127.0.0.1`, `::1` or `localhost`; setup D takes `127.0.0.1` only). Remove the setting: Holdr listens on this computer only, and other devices come in through Tailscale Serve (setup C). |
| `E0I_LAN_REMOVED` | `HOLDR_LAN_HTTP` or a `HOLDR_LAN_HTTPS_*` setting is set, in the environment or in `holdr.conf`. Holdr's LAN modes were removed: remove the setting, and reach Holdr from other devices through Tailscale Serve (setup C). |
| `E0I_CONFIG_FILE` | `holdr.conf` is missing, unreadable, readable by others (it must be `0600`), has an unknown or repeated key or an invalid value, or a key differs from the environment (`conflict: KEY differs …`). The message names the line or key. |
| `E0I_CONTROL_DIR_UNSET` | A command needs the control directory but neither `HOLDR_CONTROL_DIR` nor `HOME` names one. Set it (setup D). |
| `E0I_CONTROL_DIR` | The control directory is missing (`npm run holdr-recovery -- init`), not a `0700` directory of yours, reached through a symbolic link, overlapping the data or release folders, or incomplete after a restore (`npm run holdr-recovery -- reinit`). |
| `E0I_DATA_DIR_UNSET` | `HOLDR_DATA_DIR` is not an absolute path, or (setup D) missing from `holdr.conf`. |
| `E0I_RELEASE_PATH` | The web release named by `HOLDR_WEB_RELEASE` is missing or not where its digest says. Build it again (D1 step 1) or `set-mode` the release you have. |
| `E0I_RUNTIME_UNVERIFIED` | `dist` runs only on the Node runtime in `VERIFIED_RUNTIMES` (22.23.3). Install exactly that version. |
| `E0I_NATIVE_HELPER` | The native path checker is missing, or does not match `HOLDR_NATIVE_COMMIT`/`HOLDR_NATIVE_MANIFEST`. Rebuild it from the commit you run (`npm run build:native --workspace @finance-tracker/api -- --commit "$(git rev-parse HEAD)"`) and copy the printed pins. |
| `E0I_BACKUP_PERMS` | A `backups` folder (or something in it) can be read or changed by others, or is not owned by you. Move it aside and run `npm run holdr-backup` again; it creates new private folders. |
| `E0I_MAINTENANCE` (exit 3) / `E0I_LIFECYCLE_BUSY` (exit 75) | Setup D: an upgrade or recovery holds the lifecycle lock. Wait for it to finish, or see [Staged upgrades](e0i-ingress.md). |
| `E0I_LEASE_ENV` | A `HOLDR_LIFECYCLE_LEASE*` variable is set in an ordinary command's environment. Unset it. |
| `output-not-owner-only`, `output-uncheckable` | A metals or retail command's folder is not private, or (macOS outside setup D) cannot be checked. See [Importing data](importing-data.md#owner-only-folders). |

## Security notes

- Never expose the API or web port to a network; both listen on loopback only.
- Never enable Tailscale Funnel for Holdr.
- Keep the data folder, control directory, `holdr.conf`, `.env`, backups and the `service-token` and `agent-token` files
  private to the account that runs Holdr.
- Every signed-in user can read and change the whole database.
- Review dependency and application updates before deploying them.
