# Costco receipts (advanced)

Holdr can keep your itemized Costco receipts next to your card spending. This is an **advanced** workflow:

- The receipts come from a *capture folder*: the receipt files and a private manifest (`manifest.private.json`), made
  by browser tooling that is **not part of this repository**. Holdr ships the converter, its checks and the importer.
- Keep capture folders, payloads and backups in your private imports folder, outside the checkout
  ([owner-only folders](importing-data.md#owner-only-folders)). On macOS the receipt commands also need Holdr's native
  path checker (same section).
- Every path is absolute, and the commands are the same in PowerShell and zsh. `<db>` is your `finance.db`
  ([Where your data lives](getting-started.md#where-your-data-lives)) and `<imports>` your imports folder.
- `npm run <command> -- --help` lists every option of a command.

## 1. Convert the capture

Check it first; this writes nothing:

```text
npm run holdr-retail-convert -- --folder <capture folder> --manifest <capture folder>/manifest.private.json --dry-run
```

Then write the payload (`holdr.retail-import` version 1) to a new file outside the capture folder:

```text
npm run holdr-retail-convert -- --folder <capture folder> --manifest <capture folder>/manifest.private.json --out <imports>/costco-receipts.json
```

Receipts that the checks cannot confirm are *held*; the converter then writes nothing unless you add `--skip-held`.
`holdr-retail-convert-owner-only` takes the same options plus `--report <new file>` (in the same folder as `--out`)
and first checks that the output folder is private.

## 2. Preview, plan and import

The receipt tables do not exist until you install them. Each step that writes needs a GO file, an authorization file
as for [checking accounts](importing-data.md#checking-accounts), and a new backup file; importing the same payload
again writes nothing. Outside the hardened deployment, set `HOLDR_CONFIG=none` for `preview`, `plan` and `report`
([why, and how in each shell](importing-data.md#checking-accounts)).

1. Preview on a private copy of your database (nothing changes in `<db>`):

   ```text
   npm run holdr-retail -- preview --db <db> --clone <imports>/receipts-preview.db --payload <imports>/costco-receipts.json
   ```

2. Plan. This prints the database reference, the schema and policy digests, and, for the payload, its `inputSha256`,
   its `membership` and what an import would do:

   ```text
   npm run holdr-retail -- plan --db <db> --payload <imports>/costco-receipts.json
   ```

3. The first time, install the tables. Write a GO file with `"format": "holdr.retail-go"`, `"version": 1`,
   `"authority": "Root"`, `"decision": "GO"`, `"command": "install"`, `"purpose": "production-install"`, a new
   `goId` (32 lowercase hexadecimal characters) and the `databaseRef`, `schemaDigest` and `policyDigest` from `plan`:

   ```text
   npm run holdr-retail -- install --db <db> --go <imports>/receipts-install-go.json --backup <imports>/pre-receipts-install.db
   ```

4. Import, with a GO file for `"command": "import"` and `"purpose": "production-import"` that also names the
   `inputSha256` and `membership` from `plan`:

   ```text
   npm run holdr-retail -- import --db <db> --payload <imports>/costco-receipts.json --go <imports>/receipts-import-go.json --backup <imports>/pre-receipts-import.db
   ```

5. Check the receipts in the web app, then delete or encrypt the capture folder. `npm run holdr-retail -- report --db <db>`
   prints counts only.

## 3. Item categories

[Retail item categories](retail-operator.md) files each product under a category, from a worklist you review.
