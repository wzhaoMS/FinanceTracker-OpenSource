# Card sync agent (experimental)

The card sync agent saves your American Express statements into Holdr without you downloading and converting each file
by hand. It has two parts that run on the same computer as your Holdr:

- the **Holdr Card Sync** browser extension (Chrome or Edge on Windows, Chrome on macOS), which adds a small panel to
  the American Express website, and
- the **receiver**, a small Node.js program that listens only on `127.0.0.1` (this computer).

When you click **Sync** in the panel, the extension reads your statements from the signed-in American Express page and
hands them to the receiver. The receiver converts them with Holdr's own card-import tool into redacted
`holdr.card-import` files in a private folder on your computer, and asks your Holdr how many of the rows are new. You
then import each file in Holdr's web page, where you review it first. Nothing is imported without that review.

> **Status: experimental.** It reads American Express's website as it is today; when the site changes, syncing can stop
> working until the agent is updated. Keep your Holdr backups current, and check each import's preview.

## How your data is protected

- **Everything stays on this computer.** The receiver listens on `127.0.0.1` only, and it talks to the Holdr API only at
  `http://127.0.0.1:<port>` (default `http://127.0.0.1:4000`), where Holdr listens. It refuses any other address,
  `localhost` and `[::1]` included.
- **The extension and the receiver are paired.** The receiver creates a random pairing key in a file only your account
  can read, inside the extension's folder (`agents/card-sync/extension/local-key.json`, never committed). Every request
  between them is authenticated with that key and encrypted (AES-GCM), and the key itself is never sent. A captured request
  cannot be replayed. Web pages cannot read the key, and the receiver refuses requests from any other origin or host name.
- **Raw exports are kept for seconds, in a private folder.** The statements American Express sends are written only to
  `<imports>/raw`, and deleted as soon as the card's file is converted, whether the conversion worked or not; any left
  over after a crash are deleted when the receiver starts. Only your account can open the imports folder: on Windows it
  is owned by you and open only to you and SYSTEM (Windows itself), with nothing inherited from the folder above, like
  the private folders that `npm run start:local` and the README's commands create; on macOS its mode is `0700`. The
  receiver makes the folder, and its `raw` and `outbox` folders, private each time it starts.
- **The converted files are redacted.** They hold dates, amounts, descriptions, categories and the last four digits of
  the card. Card numbers are cut, card member names and addresses are dropped, and transaction references are hashed.
- **Holdr is only read.** The receiver uses Holdr's *service token* (a key file Holdr creates in its data folder, accepted
  only from this computer) to read Holdr's version, your card accounts and which dates are imported, and to ask for import
  previews, which write nothing. It never creates accounts or imports anything. It sends the token only to a program that
  runs under your own account: see [On a computer with other accounts](#on-a-computer-with-other-accounts).
- **Your bank sign-in is never touched.** You sign in to American Express yourself. The extension never sees or stores your
  password, never clicks, submits or changes anything on the bank's site, and only reads what your signed-in page already
  shows: the card list, statement dates, and the statement CSV exports that American Express's own **Download** button
  produces. It waits at least 1.2 seconds between requests and stops at the first sign that the session ended or the site
  wants it to slow down.
- **It only runs when you ask.** The panel starts **OFF**. Nothing is read until you switch it **ON** and click **Sync**,
  and switching it OFF stops a sync at once. There is no background syncing.

## What is supported

| Issuer | Status |
|---|---|
| American Express, US-dollar accounts on `global.americanexpress.com` | Supported: closed statements and the current period's posted transactions, for every card on your sign-in (additional cards are part of the basic card's statements) |
| Chase, Citi and other issuers | Not supported by the agent. Download your statements from the issuer and convert them with the offline card-import tool, as described in [Importing data](importing-data.md) |

Limits:

- Only **posted** transactions are read. Pending charges appear after they post.
- Two cards on one sign-in with the same last five digits are not synced; the panel says so.
- Accounts in other currencies, or sites with day-month dates, are not supported.
- The first sync looks back over the last 12 closed statements (change it with `--history`, up to 60).

## Before you start

You need:

- **Node.js 22 (22.3 or later)** and **Git**.
- **Google Chrome** or **Microsoft Edge** (Windows), or **Google Chrome** (macOS).
- **Holdr running on the same computer**, with a user you can sign in with. Start it with `npm run start:local` in your
  checkout (see the [README](../README.md)); it creates Holdr's service token in its data folder on first start.
- An American Express online account.

On Windows, **Windows PowerShell 5.1** (the PowerShell that comes with Windows) does not run `npm` until scripts are
allowed: it says `npm.ps1 cannot be loaded because running scripts is disabled on this system`. Allow them once, for your
account only; this needs no administrator rights:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Or type `npm.cmd` wherever this guide says `npm`, for example `npm.cmd run agent -- check`.

All commands run in your checkout (`%USERPROFILE%\src\holdr` or `~/src/holdr`, as in
[Getting started](getting-started.md#2-get-holdr); `<repository-url>` is the HTTPS address under **Code** on the
repository's GitHub page). Never clone it straight into your home folder: there `holdr` is the same folder as the
imports folder's `Holdr` (Windows and macOS do not tell the two names apart), and the receiver refuses to start.

## Install on Windows (PowerShell; Chrome or Edge)

1. Get the code and its dependencies, if you have not already:

   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\src" | Out-Null
   Set-Location "$env:USERPROFILE\src"
   git clone <repository-url> holdr
   Set-Location holdr
   npm ci
   ```

2. Start Holdr in its own window and leave it running:

   ```powershell
   npm run start:local
   ```

3. In a second PowerShell window, go to your checkout and create the pairing key:

   ```powershell
   Set-Location "$env:USERPROFILE\src\holdr"
   npm run agent -- pair
   ```

4. Load the extension:
   1. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
   2. Turn on **Developer mode**.
   3. Choose **Load unpacked** and select the folder `agents\card-sync\extension` in your checkout
      (`%USERPROFILE%\src\holdr\agents\card-sync\extension`).
   4. Check that **Holdr Card Sync (experimental)** shows the ID `lhmdiolphfkhifphmgimglieniknblbm`.

5. Start the receiver and leave the window open (or set up [auto-start](#start-the-receiver-automatically)):

   ```powershell
   npm run agent
   ```

   It prints where it saves files, and whether it can reach your Holdr.

6. Check everything in a third window, in your checkout:

   ```powershell
   npm run agent -- check
   ```

   It lists each part as `ok`, `note` or `PROBLEM`, with what to do about each problem.

Converted files go to `%USERPROFILE%\Holdr\imports\outbox`.

## Install on macOS (zsh; Chrome)

1. Get the code and its dependencies, if you have not already:

   ```zsh
   git clone <repository-url> holdr
   cd holdr
   npm ci
   ```

2. Start Holdr in its own Terminal window and leave it running:

   ```zsh
   npm run start:local
   ```

3. In a second Terminal window, in the same folder, create the pairing key:

   ```zsh
   npm run agent -- pair
   ```

4. Load the extension:
   1. Open `chrome://extensions` in Chrome.
   2. Turn on **Developer mode**.
   3. Choose **Load unpacked** and select the folder `agents/card-sync/extension` in your `holdr` folder.
   4. Check that **Holdr Card Sync (experimental)** shows the ID `lhmdiolphfkhifphmgimglieniknblbm`.

5. Start the receiver and leave the window open (or set up [auto-start](#start-the-receiver-automatically)):

   ```zsh
   npm run agent
   ```

6. Check everything in a third window:

   ```zsh
   npm run agent -- check
   ```

Converted files go to `~/Holdr/imports/outbox`.

`npm run agent` runs `node --import tsx agents/card-sync/receiver.mjs`. The receiver also runs as
`node agents/card-sync/receiver.mjs` (it loads tsx itself); the auto-start setups below use that form.

## Sync your statements

1. Open <https://global.americanexpress.com> and sign in as usual.
2. The **Holdr** panel appears in the bottom-right corner. A green dot means the receiver is connected; a red dot means it
   is not (the panel says why).
3. Switch the panel **ON** and click **Sync**. Keep the tab open while it runs; the panel shows its progress.
4. When it finishes, the panel lists each card, for example:

   ```text
   Alex ··12345 Sample Rewards: saved 212 rows; Holdr preview: 23 new, 189 already imported
   ··67890 Sample Cash: saved 31 rows; new card: create its account in the import dialog
   ```

   The receiver's log shows the same counts, with the file names. A card whose rows are all in Holdr already gets no
   file.
5. Switch the panel **OFF** when you are done, if you like. The switch is remembered.

Each card gets one file named after its last five digits and the dates it covers, such as
`amex-12345-2026-01-15-to-2026-11-24.json`.

What a sync fetches: the current period, and every closed statement (of the last 12) from the first one that Holdr does
not hold yet. Statements already imported, or waiting in the outbox, are not fetched again once they have settled: a
statement counts as settled when the receiver read it at least 3 days after its closing date. Until then, every sync
reads it again, so purchases made on the closing date that post a day or two later are not missed. Repeated reads are
harmless; Holdr recognises rows it already holds. The receiver records when it read each statement in
`receiver-state.json`, in the imports folder (dates only).

## Review and import in Holdr

1. Click **Open Holdr** in the panel (or open Holdr yourself: `http://127.0.0.1:5173` by default, or its `https://`
   address in [HTTPS mode](#holdr-in-https-mode)) and sign in.
2. Go to **Spending** (Card transactions) and choose **Import redacted JSON**.
3. Choose a file from the outbox folder (`%USERPROFILE%\Holdr\imports\outbox` on Windows, `~/Holdr/imports/outbox` on
   macOS).
4. Choose the card account. The first time for a card, choose to create a new card account: the owner, and the card's
   ending. The dialog suggests its last four digits; the five in the file name also work, and tell apart two cards
   whose last four are the same. Later files of that card match this account by themselves.
5. Read the preview: new rows, duplicates, possible duplicates, and any questions. Answer them, then choose **Import**.
6. Check the result in **Spending**.

Importing the same file twice adds nothing. Once a file is imported, delete it:

```text
npm run agent -- outbox           # lists the waiting files with Holdr's preview counts
npm run agent -- outbox --clean   # deletes the files Holdr already holds completely
```

## Holdr in HTTPS mode

If you start Holdr with `--https-origin https://<machine>.<tailnet>.ts.net` (or `HOLDR_PUBLIC_ORIGIN`), to reach it from
your phone through Tailscale Serve as the README's
[Using Holdr from your phone or another computer](../README.md#using-holdr-from-your-phone-or-another-computer)
describes, Holdr's sign-in cookie is `Secure`, and signing in at `http://127.0.0.1:5173` no longer works. Give the
receiver Holdr's `https://` address, so that **Open Holdr** opens it:

- By hand: `npm run agent -- --web-url https://<machine>.<tailnet>.ts.net`, or set `HOLDR_WEB_URL` to it.
- Windows auto-start: add `-WebUrl https://<machine>.<tailnet>.ts.net` when you run `register-task.ps1`
  ([Windows: a scheduled task at sign-in](#windows-a-scheduled-task-at-sign-in)).
- macOS auto-start: add `--web-url https://<machine>.<tailnet>.ts.net` to `render-plist.mjs`
  ([macOS: a LaunchAgent](#macos-a-launchagent)), which puts it in the LaunchAgent's `ProgramArguments`.

Nothing else changes. The address is only opened in your browser; the receiver never connects to it. It still listens
on `127.0.0.1` only, and reads Holdr through its API on `http://127.0.0.1:4000` with the service token, which HTTPS mode
does not affect.

## Start the receiver automatically

### Windows: a scheduled task at sign-in

Register a task that starts the receiver whenever you sign in, as you and without administrator rights:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File agents\card-sync\install\windows\register-task.ps1
```

It uses the `node` on your `PATH` (or `-NodePath C:\path\to\node.exe`) and runs the receiver in a hidden window (one may
flash briefly at sign-in), restarting it up to three times if it fails. It starts the receiver right away, too, after
stopping any receiver that is already running (one started by hand included), so that the receiver from this checkout
gets the port. The log is `%USERPROFILE%\Holdr\imports\receiver.log`. Options:

| Option | Meaning |
|---|---|
| `-Imports <folder>` | another imports folder (default `%USERPROFILE%\Holdr\imports`) |
| `-DataDir <folder>` | Holdr's data folder, only if you start Holdr with `--data-dir` or `HOLDR_DATA_DIR`; without it the receiver finds the folder itself (see [Settings](#settings)) |
| `-WebUrl <address>` | the address **Open Holdr** opens: Holdr's `https://` address in [HTTPS mode](#holdr-in-https-mode) |
| `-AppUrl`, `-Port` | the same settings as `--app-url` and `--port` |
| `-NoStart` | register without stopping or starting anything now |
| `-DefinitionOnly` | print the task definition and register nothing |

To stop the receiver until the next sign-in:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File agents\card-sync\install\windows\stop-receiver.ps1
```

Start it again with `Start-ScheduledTask -TaskName 'Holdr Card Sync'`. Stopping the task alone (`Stop-ScheduledTask`,
or **End** in Task Scheduler) is not enough: it ends the hidden PowerShell window, but the receiver it started keeps
running and keeps the port. `stop-receiver.ps1` stops the task's run and then the receiver itself, and waits until it
has exited.

To stop and remove the task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File agents\card-sync\install\windows\unregister-task.ps1
```

This also stops any receiver that is running, including one started by hand.

### macOS: a LaunchAgent

From your `holdr` folder, in the Terminal where `npm run agent` works:

```zsh
launchctl bootout gui/$(id -u)/local.holdr.card-sync 2>/dev/null
node agents/card-sync/install/macos/render-plist.mjs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.holdr.card-sync.plist
```

The first line unloads the LaunchAgent if you installed it before (and says nothing if you did not), so you can run the
three lines again at any time. `render-plist.mjs` writes `~/Library/LaunchAgents/local.holdr.card-sync.plist` (mode
`0644`) for this checkout and the `node` that `command -v node` shows. It XML-escapes every value, so folders with
spaces, `&`, `|` or quotes in their names need no hand editing. It also creates the log folder `~/Library/Logs/Holdr`
(mode `0700`), which launchd needs before it starts the receiver, and checks the file with `plutil -lint` before putting
it in place. To see the file without writing it, add `--print`.

The LaunchAgent passes the receiver only the settings you give `render-plist.mjs`, as options or as the environment
variables of [Settings](#settings); everything else is the receiver's own default, as with `npm run agent`:

| Option | When |
|---|---|
| `--data-dir <folder>` | you start Holdr with `--data-dir` or `HOLDR_DATA_DIR`; without it the receiver finds Holdr's data folder itself |
| `--web-url https://<machine>.<tailnet>.ts.net` | Holdr runs in [HTTPS mode](#holdr-in-https-mode) |
| `--imports <folder>`, `--app-url <address>`, `--port <number>` | as for `npm run agent` |
| `--node <path>`, `--log-dir <folder>` | another `node`, or another log folder than `~/Library/Logs/Holdr` |

The receiver now starts at every login and restarts if it fails. Its log is `~/Library/Logs/Holdr/card-sync-receiver.log`;
anything Node.js itself prints on failure goes to `~/Library/Logs/Holdr/card-sync-receiver-errors.log`. Useful commands:

```zsh
launchctl print gui/$(id -u)/local.holdr.card-sync | head -n 20   # is it running?
launchctl kickstart -k gui/$(id -u)/local.holdr.card-sync         # restart it
launchctl bootout gui/$(id -u)/local.holdr.card-sync              # stop it until the next bootstrap
```

After moving the checkout, installing another Node.js or changing a setting, run the three lines above again.

## Settings

Every setting is a command-line option, and each also reads an environment variable. Options win over variables, and
both over the defaults.

| Option | Variable | Default | Meaning |
|---|---|---|---|
| `--port` | `HOLDR_SYNC_PORT` | `4401` | the receiver's port on `127.0.0.1`; the extension follows it through the pairing file (reload the extension after a change) |
| `--app-url` | `HOLDR_APP_URL` | `http://127.0.0.1:4000` | your Holdr API; loopback addresses only |
| `--web-url` | `HOLDR_WEB_URL` | `http://127.0.0.1:5173` | the Holdr page that **Open Holdr** opens; Holdr's `https://` address in [HTTPS mode](#holdr-in-https-mode) |
| `--data-dir` | `HOLDR_DATA_DIR` | see below | Holdr's data folder; its `service-token` file is used |
| `--token-file` | `HOLDR_TOKEN_FILE` | `<data folder>/service-token` | the service token file itself (`HOLDR_SERVICE_TOKEN_FILE` is honoured too) |
| `--imports` | `HOLDR_IMPORTS` | `~/Holdr/imports` | the private imports folder (`raw` and `outbox` inside it); must be outside the checkout |
| `--extension-dir` | `HOLDR_EXTENSION_DIR` | `agents/card-sync/extension` | the extension folder you loaded, where the pairing file goes |
| `--extension-id` | `HOLDR_EXTENSION_ID` | `lhmdiolphfkhifphmgimglieniknblbm` | the extension's ID, if you load a changed copy of it |
| `--history` | `HOLDR_SYNC_HISTORY` | `12` | how many closed statements a sync looks back over (1 to 60) |
| `--owner-labels` | `HOLDR_OWNER_LABELS` | `alex=Alex,casey=Casey,joint=Joint` | how the receiver and panel name Holdr's three owner slots |
| `--log-file` | `HOLDR_SYNC_LOG` | none | also append the log to this file |

Without `--data-dir`, the receiver uses the data folder of `npm run start:local` (`%LOCALAPPDATA%\Holdr\data` on Windows,
`~/Library/Application Support/Holdr/data` on macOS) once Holdr has created its `service-token` file there, and otherwise
`apps/api/data` in the checkout, where `npm run dev` keeps it. It looks when it starts; `npm run agent -- check` shows the
token file it uses. The auto-start setups pass a data folder only when you give one, so they follow the same rule. The
log holds dates, counts, card endings and file names, never amounts, descriptions or references.

## Update

1. Stop the receiver:
   - Started by hand: Ctrl+C in its window.
   - Windows auto-start:
     `powershell -NoProfile -ExecutionPolicy Bypass -File agents\card-sync\install\windows\stop-receiver.ps1`.
     (`Stop-ScheduledTask` alone leaves the receiver running; see [Windows: a scheduled task at sign-in](#windows-a-scheduled-task-at-sign-in).)
   - macOS auto-start: `launchctl bootout gui/$(id -u)/local.holdr.card-sync`.
2. Update the checkout: `git pull`, then `npm ci`.
3. Reload the extension: the reload arrow on **Holdr Card Sync** in `chrome://extensions` or `edge://extensions`, then
   reload any open American Express tab.
4. Start the receiver again:
   - By hand: `npm run agent`.
   - Windows auto-start: run `register-task.ps1` again (as in
     [Windows: a scheduled task at sign-in](#windows-a-scheduled-task-at-sign-in), with the same options). It stops any
     receiver still running, registers the task for the updated checkout and starts it.
   - macOS auto-start: run the three lines of [macOS: a LaunchAgent](#macos-a-launchagent) again (`launchctl bootout`,
     `render-plist.mjs`, then `launchctl bootstrap`), which also picks up changes to the LaunchAgent.
5. Run `npm run agent -- check`. If it reports that the receiver running on the port "was started from other code", a
   receiver from before the update is still running: stop it as in step 1, then start it again.

Update Holdr and the agent together, from the same checkout.

## Uninstall

1. Remove the auto-start, if you set it up:
   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File agents\card-sync\install\windows\unregister-task.ps1`
     (it stops the receiver, then removes the task)
   - macOS:

     ```zsh
     launchctl bootout gui/$(id -u)/local.holdr.card-sync 2>/dev/null
     rm -f ~/Library/LaunchAgents/local.holdr.card-sync.plist
     rm -f ~/Library/Logs/Holdr/card-sync-receiver.log ~/Library/Logs/Holdr/card-sync-receiver.log.1 \
       ~/Library/Logs/Holdr/card-sync-receiver-errors.log
     ```
2. Stop a receiver you started by hand (Ctrl+C in its window).
3. Remove the extension: **Remove** on **Holdr Card Sync** in `chrome://extensions` or `edge://extensions`. This also
   deletes its stored settings.
4. Delete the pairing key file `agents/card-sync/extension/local-key.json`.
5. Delete the imports folder, after importing anything you still want:
   - Windows: `Remove-Item -Recurse -Force "$env:USERPROFILE\Holdr\imports"`
   - macOS: `rm -rf ~/Holdr/imports`

Transactions you imported stay in Holdr; delete them there if you want them gone.

## Troubleshooting

Start with `npm run agent -- check`. It names each problem and what to do.

| What you see | What to do |
|---|---|
| Windows PowerShell: "npm.ps1 cannot be loaded because running scripts is disabled on this system" | Run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once (no administrator rights needed), or type `npm.cmd` instead of `npm` |
| No panel on the American Express site | Reload the page after loading or reloading the extension; make sure the extension is enabled and you are on `global.americanexpress.com` |
| Red dot, "The Holdr receiver is not running on this computer" | Start it with `npm run agent`, or check your auto-start; `npm run agent -- check` |
| "Not paired with the Holdr receiver yet" | Run `npm run agent -- pair`, then reload the extension |
| "The receiver has a different pairing key" | Restart the receiver, then reload the extension (after `pair --rotate` both must restart) |
| "The receiver does not accept this extension (ID …)" | You loaded a changed copy of the extension, so its ID differs: start the receiver with `HOLDR_EXTENSION_ID` set to the ID the message shows |
| "port 4401 on 127.0.0.1 is in use" | Another receiver (often the auto-start one) is already running; use that one, or stop it: on Windows with `stop-receiver.ps1` (see [Update](#update)), on macOS with Ctrl+C in its window or `launchctl bootout gui/$(id -u)/local.holdr.card-sync`. To use another port: `--port 4402`, then reload the extension |
| `check` says the receiver "was started from other code" | A receiver from before an update is still running: stop it as in [Update](#update), step 1, then start it again |
| `check`: "PROBLEM Imports folder … (other accounts have access)", "(owned by …)" or "(mode … lets other accounts in)" | Start the receiver, or restart it as in [Update](#update): each time it starts, it makes the folder private (on Windows yours, open to you and SYSTEM only; on macOS mode `0700`). If it cannot, choose a folder of your own with `--imports`. A folder made with the README's commands is private already |
| macOS: the receiver does not start; `launchctl print gui/$(id -u)/local.holdr.card-sync` shows `last exit code = 78` | launchd could not open the log file: run `node agents/card-sync/install/macos/render-plist.mjs` again (it creates the log folder), then `launchctl kickstart -k gui/$(id -u)/local.holdr.card-sync` |
| macOS: `launchctl bootstrap` says "Bootstrap failed: 5: Input/output error" | The LaunchAgent is loaded already: run `launchctl bootout gui/$(id -u)/local.holdr.card-sync`, wait a moment, then `launchctl bootstrap` again (the three lines of [macOS: a LaunchAgent](#macos-a-launchagent) do both) |
| **Open Holdr** opens Holdr, but signing in fails | Holdr runs in HTTPS mode: give the receiver its `https://` address, as in [Holdr in HTTPS mode](#holdr-in-https-mode) |
| "Holdr is not running at http://127.0.0.1:4000" | Start Holdr (`npm run start:local`), or set `HOLDR_APP_URL` to its address |
| "Holdr's service token file was not found" | Start Holdr once (it creates the file); if Holdr uses another data folder, give the receiver that folder too: `--data-dir` or `HOLDR_DATA_DIR` (or `HOLDR_TOKEN_FILE`), `-DataDir` for the Windows task, `--data-dir` for `render-plist.mjs` |
| "Holdr refused the service token" | Holdr made a new token (its data folder changed, or the file was deleted): point the receiver at the current one and restart it |
| "Holdr's database schema is …", "has no … route", "did not accept the converted file" | Holdr and the agent come from different versions: update both from the same checkout |
| "American Express ended the session" | Sign in again, then Sync |
| "American Express asked to slow down" or "refused the request" | Wait a while before syncing again |
| "No cards found on this page" | Open your American Express account home page, then Sync |
| "not synced (another card here has the same ending)" | A known limit; download those statements from American Express and use the offline tool |
| "the export could not be converted" | American Express may have changed its export. Please report it with the message, but never attach a real export |
| "syncing is paused" / "a raw export could not be deleted" | Another program (often a backup or antivirus tool) holds a file in `<imports>/raw`; close it, then restart the receiver |
| Holdr's import dialog says "This is not a redacted Holdr card import" | Choose a `.json` file from the outbox folder |
| Holdr's own log shows "unknown setting HOLDR_IMPORTS ignored" | Harmless: Holdr and the receiver were started with the same environment |
| On Windows, a window flashes at sign-in | The auto-start task's hidden PowerShell window; expected |

## Security notes

- The receiver serves no data in the clear: apart from a status check (`GET http://127.0.0.1:4401/healthz`, which says only
  that a receiver is running), every route is inside the encrypted channel.
- Anyone who can read your account's files can read the pairing key and Holdr's service token, as with every program you
  run. Use your own computer account, keep the checkout and the imports folder in it, and do not share either file.
- The converted files are financial data. They stay in your private imports folder until you delete them;
  `npm run agent -- outbox --clean` removes those already in Holdr.
- The agent never sends anything off this computer: the bank pages are read inside your own browser session, and the
  receiver talks only to the extension and to the Holdr API on `127.0.0.1`.

## For developers

- Layout: `agents/card-sync/receiver.mjs` (entry), `lib/` (receiver), `extension/` (the unpacked extension), `install/`
  (auto-start: the Windows task scripts, and `macos/render-plist.mjs`, which writes the LaunchAgent), `tests/`
  (synthetic fixtures only).
- Tests (no network, no browser): `node --import tsx --test agents/card-sync/tests/*.test.mjs`. They cover the encrypted
  channel, the loopback-only listener, private folders (Windows access lists by Holdr's owner-only rule) and raw-file
  deletion, conversion of a synthetic export, which statements a sync fetches (closing dates included), the Holdr API
  client against a fake API, configuration (Windows paths included), the extension's page reader, panel and worker
  driven end to end, the auto-start definitions (the LaunchAgent's XML escaping included) and the Windows stop script.
- The converter is Holdr's own (`packages/shared/src/cardImportTool`), loaded from source through tsx: the receiver
  needs no build of `packages/shared`.
