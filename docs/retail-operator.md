# Retail item categories (advanced)

After you import [Costco receipts](costco-receipts.md), each product (merchant and item number) and each department can
be filed under a category of Holdr's shared category tree. This is an advanced, local-only workflow, and nothing in the
web app reads these categories yet. Unknown or ambiguous products stay uncategorized until you review them.

Keep every file in your private imports folder, outside the checkout. Paths are absolute, and the commands are the same
in PowerShell and zsh. Outside the hardened deployment, set `HOLDR_CONFIG=none` for `taxonomy worklist` and
`taxonomy plan` ([why, and how in each shell](importing-data.md#checking-accounts)).

1. Write a worklist of every product and department your receipts name. It prints counts and the file's SHA-256:

   ```text
   npm run holdr-retail -- taxonomy worklist --db <db> --out <imports>/taxonomy-worklist.json
   ```

2. Classify the worklist's entries, by hand or with a tool you trust, into a `holdr.retail-taxonomy-assignments` file
   bound to the worklist's SHA-256. Then turn it into a mapping (`holdr.retail-taxonomy-mapping`) under a new
   `decisionId`:

   ```text
   npm run holdr-retail -- taxonomy adopt --input <imports>/assignments.json --worklist <imports>/taxonomy-worklist.json --out <imports>/taxonomy-mapping.json
   ```

3. See what the mapping would do: its actions, the counts as if imported, and the `planDigest`:

   ```text
   npm run holdr-retail -- taxonomy plan --db <db> --mapping <imports>/taxonomy-mapping.json
   ```

4. Import it, with a GO file (`"format": "holdr.retail-go"`, as in [Costco receipts](costco-receipts.md)) for
   `"command": "taxonomy-import"` and `"purpose": "production-taxonomy"` that names the mapping's `mappingSha256`, its
   `decisionId`, the `taxonomyDigest` and the `planDigest`, and a new backup file:

   ```text
   npm run holdr-retail -- taxonomy import --db <db> --mapping <imports>/taxonomy-mapping.json --go <imports>/taxonomy-go.json --backup <imports>/pre-taxonomy.db
   ```

Importing the same mapping again writes nothing (`retail-already-imported`). Rows about precious metals may report
`metalHold` and stay unresolved: gold and silver have [their own ledger](importing-data.md).

## Result and refusal codes

The commands print counts and fixed codes, never product titles, item numbers, account identifiers or receipt values:

- `retail-taxonomy-worklist-written`, `retail-taxonomy-mapping-written`, `retail-taxonomy-planned`,
  `retail-taxonomy-imported`: the step succeeded.
- `retail-taxonomy-file-invalid`: a worklist, assignments or mapping file is not in its format.
- `retail-taxonomy-node-unknown`: a category is not in the tree.
- `retail-taxonomy-source-invalid`, `retail-taxonomy-subject-unknown`: an assignment names a source or a product the
  worklist does not have.
- `retail-taxonomy-worklist-mismatch`: the assignments were made for another worklist.
- `retail-no-shared-lease`: set `HOLDR_CONFIG=none` (above).
