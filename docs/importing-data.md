# Importing data

Holdr converts and checks imports on your computer and stores normalized records in its SQLite database. Raw exports
never go to the web app: offline converters turn them into redacted JSON payloads first. Keep raw files outside the
repository, and delete or encrypt them once the import is verified.

Commands run from the repository folder. Where Windows PowerShell and macOS zsh differ, both are shown.

## Before the first import

1. Start Holdr (`npm run start:local`) and sign in.
2. Back up: `npm run holdr-backup` (same in both shells).
3. Download the smallest useful date range from the provider.
4. Put it in a private imports folder (next section), outside the repository.

## Owner-only folders

Keep downloads and converted payloads in a folder only your account can open.

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
imports="$HOME/Holdr/imports"
mkdir -p "$imports" && chmod 700 "$HOME/Holdr" "$imports"
```

The commands below start by naming this folder again (`$imports` in PowerShell, `imports` in zsh), so each block also
works in a new window.

What each tool requires of its output place:

- The card converter (`holdr-card-import --out`) writes a new file with mode `0600`; on Windows the file takes its
  folder's permissions, so use the folder above.
- The statement and checking converters create a new file or folder (never an existing one) with modes `0600`/`0700`.
- The gold/silver and receipt commands (`holdr-metals-convert`, `holdr-metals`, `holdr-retail-convert-owner-only`,
  `holdr-retail`) **refuse** a folder that is not owner-only (`output-not-owner-only`) or that they cannot check
  (`output-uncheckable`). On Windows they read the folder's ACL: it must be owned by you and grant access only to you,
  SYSTEM and Administrators (the commands above do that). On macOS they read permissions through Holdr's native path
  checker: build it once with `npm run build:native --workspace @finance-tracker/api -- --commit "$(git rev-parse HEAD)"`
  (it needs the Xcode command line tools) and export the two pins it prints,
  `export HOLDR_NATIVE_COMMIT=<commit> HOLDR_NATIVE_MANIFEST=<manifest>`, in the Terminal that runs these commands (the
  hardened deployment keeps them in `holdr.conf`; see [Deployment](deployment.md#d2-dist-tailscale-serve-to-a-unix-socket)).
  Without them these commands refuse on macOS.

## What converts how

| Data | Raw format | Converter (`npm run …`) | Result, and how it is imported |
|---|---|---|---|
| American Express card activity | CSV | `holdr-card-import -- amex-csv` | `holdr.card-import` v1 JSON → web upload |
| Bilt card activity | CSV | `holdr-card-import -- bilt-csv` | `holdr.card-import` v1 JSON → web upload |
| Wells Fargo card activity | CSV | `holdr-card-import -- wf-csv` | `holdr.card-import` v1 JSON → web upload |
| Any issuer's card statement download | OFX, QFX, QBO | `holdr-card-import -- ofx --issuer <slug>` | `holdr.card-import` v1 JSON → web upload |
| Discover card monthly statements | PDF | `holdr-card-statement-convert` | one `holdr.card-import` v1 JSON per statement → web upload |
| Checking accounts | CSV, OFX, QFX, QBO, supported statement PDFs | `holdr-checking-convert` | `holdr.checking-import` payload → `npm run holdr-checking -- import` |
| Costco receipts | a capture folder with a private manifest | `holdr-retail-convert` | `holdr.retail-import` payload → `npm run holdr-retail -- import` |
| Gold and silver orders (Costco, Walmart, CollectPure) | a capture folder, or a Costco retail payload | `holdr-metals-convert` | `holdr.metals-import` payload → `npm run holdr-metals -- import` |
| Portfolio positions | a broker table as JSON (`{ headers, rows }`) | the Investing tab's import panel | previewed trades, saved one by one |
| Trades and cash | typed in | the Investing tab's forms | saved directly |

Every converter has `--help`, works offline and never opens the database. The receipt, gold/silver and Amazon workflows
read capture folders made by browser tooling that is **not part of this repository**; only their formats and validators
are (`packages/shared/src/retailImportTool`, `packages/shared/src/metalsLedger`, `tools/amazon-capture`). See
[Costco receipts](costco-receipts.md) and [Retail item categories](retail-operator.md).

Holdr never asks for bank or broker passwords and does not log in to providers.

## The web upload accepts redacted JSON only

**Spending → Import redacted JSON** accepts only `holdr.card-import` version 1 JSON, the converters' output. It never
accepts raw CSV, OFX, QFX, QBO or PDF files.

## Card exports: convert, preview, import

`--status` is required, because nothing in an export proves that its statement has closed: `posted` for a closed
statement, `pending` for an open period, `export` for Bilt, or `--closed-through YYYY-MM-DD` (OFX and Bilt) to split
posted from pending rows.

Windows (PowerShell):

```powershell
$imports = Join-Path $env:USERPROFILE 'Holdr\imports'
npm run holdr-card-import -- --help

# A closed American Express statement period.
npm run holdr-card-import -- amex-csv "$imports\activity.csv" --status posted --out "$imports\amex-2026-03.json"

# Bilt: say how housing payments made through the card count.
npm run holdr-card-import -- bilt-csv "$imports\bilt.csv" --status export --loan-payments not-spending --out "$imports\bilt-2026-03.json"

# Wells Fargo: name the range you downloaded.
npm run holdr-card-import -- wf-csv "$imports\wells-fargo.csv" --status posted --from 2026-01-01 --to 2026-03-31 --out "$imports\wf-2026-q1.json"

# OFX, QFX or QBO from any issuer: name the issuer with a lowercase slug.
npm run holdr-card-import -- ofx "$imports\statement.qfx" --issuer samplebank --status posted --out "$imports\samplebank-2026-03.json"
```

macOS (zsh):

```zsh
imports="$HOME/Holdr/imports"
npm run holdr-card-import -- --help

# A closed American Express statement period.
npm run holdr-card-import -- amex-csv "$imports/activity.csv" --status posted --out "$imports/amex-2026-03.json"

# Bilt: say how housing payments made through the card count.
npm run holdr-card-import -- bilt-csv "$imports/bilt.csv" --status export --loan-payments not-spending --out "$imports/bilt-2026-03.json"

# Wells Fargo: name the range you downloaded.
npm run holdr-card-import -- wf-csv "$imports/wells-fargo.csv" --status posted --from 2026-01-01 --to 2026-03-31 --out "$imports/wf-2026-q1.json"

# OFX, QFX or QBO from any issuer: name the issuer with a lowercase slug.
npm run holdr-card-import -- ofx "$imports/statement.qfx" --issuer samplebank --status posted --out "$imports/samplebank-2026-03.json"
```

The converter refuses to replace an existing file unless you add `--force`. `--member "NAME=OWNER"` assigns an
American Express card member to `alex`, `casey` or `joint`, the household's three owner slots (shown as Alex, Casey
and Joint); names are never written. The `--expect-*` options check the rows against the figures printed on the
statement; a mismatch writes nothing (exit 3) unless you add `--allow-mismatch`.

Discover statement PDFs (the output folder must not exist yet):

Windows (PowerShell):

```powershell
$imports = Join-Path $env:USERPROFILE 'Holdr\imports'
$pdfs = (Get-ChildItem "$imports\discover\*.pdf").FullName
npm run holdr-card-statement-convert -- --card 1234 --dry-run $pdfs
npm run holdr-card-statement-convert -- --card 1234 --out-dir "$imports\discover-json" $pdfs
```

macOS (zsh):

```zsh
imports="$HOME/Holdr/imports"
npm run holdr-card-statement-convert -- --card 1234 --dry-run "$imports"/discover/*.pdf
npm run holdr-card-statement-convert -- --card 1234 --out-dir "$imports/discover-json" "$imports"/discover/*.pdf
```

Every statement must reconcile to the cent and chain to its neighbours, or it is held and the report says why.

Then, in Holdr:

1. Open **Spending** and choose **Import redacted JSON**.
2. Select the JSON file.
3. Choose the card account, or **New card account…** the first time.
4. Review the preview: new rows, possible duplicates, pending charges that have posted, the statement check, warnings.
5. Answer every question the preview asks.
6. Choose **Import**, then check the totals and any rows held for review.

Importing the same JSON again adds nothing.

## Checking accounts

Windows (PowerShell):

```powershell
$imports = Join-Path $env:USERPROFILE 'Holdr\imports'
$files = (Get-ChildItem "$imports\checking\*").FullName
npm run holdr-checking-convert -- --formats
npm run holdr-checking-convert -- --institution <slug> --label "Everyday Checking" --dry-run $files
npm run holdr-checking-convert -- --institution <slug> --label "Everyday Checking" --out "$imports\checking.json" $files
```

macOS (zsh):

```zsh
imports="$HOME/Holdr/imports"
npm run holdr-checking-convert -- --formats
npm run holdr-checking-convert -- --institution <slug> --label "Everyday Checking" --dry-run "$imports"/checking/*
npm run holdr-checking-convert -- --institution <slug> --label "Everyday Checking" --out "$imports/checking.json" "$imports"/checking/*
```

Add `--through YYYY-MM-DD` (the last complete day) for CSV files, which do not say when they were made. The report
lists coverage and balance checks, never amounts or account numbers.

The checking importer changes the database only under an authorization file that you write: a small JSON file, called
a GO file after its `"decision": "GO"` line, that names one database, one schema and, for an import, one payload, so
that an import writes exactly what you reviewed into the database you meant. All paths must be absolute. Your database
is `finance.db` in your data folder (`%LOCALAPPDATA%\Holdr\data\finance.db` on Windows,
`~/Library/Application Support/Holdr/data/finance.db` on macOS, unless you set `HOLDR_DATA_DIR`).

1. Read the values the GO file must name, writing nothing:

   ```powershell
   $imports = Join-Path $env:USERPROFILE 'Holdr\imports'
   npm run holdr-checking -- plan --db "$env:LOCALAPPDATA\Holdr\data\finance.db" --input "$imports\checking.json"
   ```

   ```zsh
   imports="$HOME/Holdr/imports"
   npm run holdr-checking -- plan --db "$HOME/Library/Application Support/Holdr/data/finance.db" --input "$imports/checking.json"
   ```

   It prints the database reference, the schema digest and the payload digest.

2. Write the GO file in your imports folder. `"authority": "Root"` and `"decision": "GO"` are fixed text; the rest
   comes from `plan`:

   ```json
   {
     "format": "holdr.checking-go", "version": 1, "authority": "Root", "decision": "GO",
     "purpose": "production-import", "command": "import", "goId": "<32 lowercase hex characters>",
     "databaseRef": "<from plan>", "schemaDigest": "<from plan>", "inputDigest": "<from plan>"
   }
   ```

   A `goId` comes from `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"` (both shells). The
   first time, create the checking tables with a GO file whose `command` is `install` and `purpose` `production-install`,
   without `inputDigest`, and `npm run holdr-checking -- install --db <db> --backup <new file> --root-go <go file>`.

3. Import. The command takes a new backup first and refuses an existing backup path:

   ```powershell
   $imports = Join-Path $env:USERPROFILE 'Holdr\imports'
   $db = "$env:LOCALAPPDATA\Holdr\data\finance.db"
   npm run holdr-checking -- import --db $db --input "$imports\checking.json" --backup "$imports\pre-checking.db" --root-go "$imports\checking-go.json"
   ```

   ```zsh
   imports="$HOME/Holdr/imports"
   db="$HOME/Library/Application Support/Holdr/data/finance.db"
   npm run holdr-checking -- import --db "$db" --input "$imports/checking.json" --backup "$imports/pre-checking.db" --root-go "$imports/checking-go.json"
   ```

The receipt and gold/silver importers follow the same pattern: `plan`, a GO file (`holdr.retail-go` or
`holdr.metals-go`), then `install` or `import` with a new backup. Run each command's `--help` for its arguments, and
mind the [owner-only folder rules](#owner-only-folders). They read capture folders made by tools that are not part of
this repository, so they are for advanced users.

Some of their read-only steps wait for the hardened macOS deployment's lifecycle lease: every `holdr-retail` command that
reads the database (`preview`, `plan`, `report`, `quarantine`, `bindings propose`, `taxonomy worklist`,
`taxonomy plan`) and `holdr-metals report` and `bindings propose`. Without that deployment they refuse with
`no-shared-lease`. Set `HOLDR_CONFIG=none` for them, which says that no hardened configuration is in use and so there is
no lease to wait for:

Windows (PowerShell; remove the variable afterwards, because `npm run start:local` refuses to start while it is set):

```powershell
$env:HOLDR_CONFIG = 'none'
npm run holdr-retail -- plan --db "$env:LOCALAPPDATA\Holdr\data\finance.db"
Remove-Item Env:HOLDR_CONFIG
```

macOS (zsh; the variable applies to that one command):

```zsh
HOLDR_CONFIG=none npm run holdr-retail -- plan --db "$HOME/Library/Application Support/Holdr/data/finance.db"
```

## Transaction boundaries

- Converters write only their requested output; they never open the database.
- Previews write nothing: the web dialog's preview, the Investing import panel's preview, and the `plan`, `preview`
  and `--dry-run` commands.
- A card import (**Import**) is decided inside one database transaction: a refusal writes no row from that file.
- A checking, receipt or gold/silver import runs inside one `IMMEDIATE` transaction after its backup: a refusal writes
  nothing from that payload. A payload that was already imported writes nothing and takes no backup.
- The Investing import panel saves the reviewed trades one request at a time. If a save fails part-way, the earlier
  rows stay saved: check the account and remove or re-enter what is missing.
- Batch commands such as the Amazon `import-batch` report which units were imported before a refusal.

Do not assume a multi-step workflow is all-or-nothing. Read each result, check the counts, and restore the pre-import
backup if you do not want a partial result.

## Duplicates and failures

- Card and checking imports use the source's own identifiers, and normalized content fingerprints where there are none.
- Pending and posted versions of a charge may need an explicit match decision; an ambiguous match is held or refused,
  never guessed.
- A parse or validation failure writes nothing. Keep the original file until the failure is understood.
- Providers change export formats without notice: always read the preview.
- Do not edit a provider export in place. Copy it, note why, and convert the copy.
- Report importer bugs ([Getting help](../README.md#getting-help)) with a minimal synthetic file, never a real statement.

## Data boundaries

- Raw files stay on the computer that runs the conversion.
- The database holds normalized financial data and the sign-in records.
- The browser may cache recently viewed pages; sign out on shared devices.
- Quote providers receive public symbols and date ranges, never account data or credentials.

## Synthetic fixture rule

Repository fixtures must be generated or clearly synthetic: reserved example domains, published test card numbers,
invented merchants, artificial dates and amounts. Real exports, account endings, names, addresses, phone numbers,
emails and statement PDFs are forbidden; `npm run privacy:scan` enforces most of this.
