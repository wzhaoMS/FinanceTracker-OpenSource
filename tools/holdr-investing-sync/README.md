# Fidelity Investing importer

> **Status: advanced, macOS only.** The command-line importer runs only on the hardened macOS deployment (it needs
> that deployment's lifecycle protocol and control directory; see [docs/deployment.md](../../docs/deployment.md)), and
> **no capture producer ships in this repository**: you supply `holdr.fidelity-investing-capture` v1 files from your
> own tooling. For everyday use, add trades in the Investing tab instead.

This backend targets the original Investing tab's existing `accounts`,
`transactions` and `account_snapshots`, not cards. It has no browser, network,
deployment or automatic database discovery. Use private local files; never commit
captures, bindings, databases or backups.

## Integration

`importFidelityInvesting(state, capture, policy, { backupDirectory, now?, transport?, mode? })`
is exported from `apps/api/src/services/fidelityInvestingSync.ts`.
`state` is an existing `SqliteStateRepo`; the caller must authenticate and authorize
the owner before invoking it. Investing accounts are currently singleton state,
not per-user accounts. Only the household's owner, who reviews it, may supply the private policy.
The importer does not infer ownership or bind accounts by last four digits.
The caller must also back up **before opening** a live `SqliteStateRepo`, since its
constructor can initialize/migrate schema. The CLI below does this automatically.
An already-open API repository must already be under its normal API lifecycle
lease; direct CLI callers must use the leased entry point, not call the service
to bypass lifecycle fencing.

The v1 input is exactly:

```ts
{
  format: 'holdr.fidelity-investing-capture', version: 1, capturedAt: string,
  accounts: [{
    sourceId: string, last4: string, currency: 'USD',
    coverage: { from: string, to: string },
    activity: [{
      key: string, date: string, description: string, symbol: string | null,
      quantity: number, pricePerUnit: number | null, amount: number, fees: number
    }],
    positions: [{
      symbol: string, quantity: number, pricePerUnit: number, costBasis: number | null,
      marketValue?: number
    }],
    cashBalance: number, pendingBalance?: number, totalValue: number
  }]
}
```

Dates are calendar ISO days; `capturedAt` is an ISO instant with a timezone.
`sourceId` is `fidelity-` plus the page-computed lowercase SHA-256 identity.
Activity keys are lowercase SHA-256 digests, unique within each source; the
capture producer must use stable occurrence identities for missing native IDs.
It must exclude cancelled transactions, scrub account numbers, and ensure positions,
cash and total value describe the same observation. `cashBalance` includes core
money-market holdings. New captures retain the signed native pending component
separately as `pendingBalance`; legacy captures without it imply no pending component.
Snapshot composition is native securities plus core plus pending, under the same
two-cent check. Holdr's single economic cash balance, cursor and snapshot cash are
core plus pending, so settlement cannot charge an executed transaction twice.
Unexplained economic cash or quantity changes still hold the whole account.
Each applied account also appends this economic cash to `account_cash_history`
in the same transaction, using the capture's Eastern market date, broker
`fidelity`, method `fidelity-capture`, and the capture digest as `source_hash`.
The existing account/date key permits only one observation per day: any existing
row wins unchanged, regardless of method or balance. Later same-day captures and
exact replays therefore never overwrite history; subsequent market days append
new rows. These are capture-time observations, not reconstructed end-of-day cash.
Held and ignored accounts write no cash history. No legacy history is deleted,
rewritten or backfilled. This append is separate from baseline cash adoption,
incremental cash proof and T0 invalidation, whose behavior is unchanged.
The appended rows are reversible by deleting only rows whose
`method = 'fidelity-capture'` within the intended account scope; that removes
only these history observations, not account cash, snapshots or ledger changes.
`costBasis` is the position's total basis, not unit cost.
Native unknown/pending basis is explicit `null`, never zero or a market-value
estimate. It can be derived only when native executions/NET amounts explain the
entire holding and their order/basis are provable. Otherwise the account holds
as `unknown-position-basis-unproven`; its pending component is not independently
applied. A disappeared position after baseline needs native closing quantity,
otherwise `closed-position-activity-unproven` holds it without deleting history.
Large price-only value changes do not hold when quantities/cash and native totals
still reconcile.
New native captures include finite `marketValue` from the same positions response's
row valuation for **every** position in an account. Mixed native/legacy rows,
null values and extra fields are rejected. This is already the whole position's
value, including an option's contract multiplier; it is not multiplied again.
The total proof uses these native values plus captured core cash, with the same
absolute two-cent tolerance. Last quote times displayed quantity need not
reproduce the native row value, so no inferred price, quantity or wider tolerance
is substituted. Existing cash-symbol classification is unchanged.
Old packets with no row `marketValue` retain the existing quantity-times-quote
reconstruction and fail closed on a mismatch; never retrofit preserved packets.
Update this importer before you update the tooling that produces your captures.

Native exercise, assignment and expiration are separate activity types. Standard
option symbols, native descriptors and 100-share contract metadata must agree.
Exercise/assignment require unique same-day option and stock legs, signed contract
and share quantities, and strike consideration/NET fees; missing or ambiguous legs
hold as `option-lifecycle-leg-unproven`. Calendar expiry alone never removes a
position. Native expiration closes the proven option at zero consideration.
For a new stock holding with unknown basis, strike consideration can include an
opening premium only when native opening activity proves it; partial/missing or
contradictory premium evidence holds as `option-lifecycle-basis-unproven`. This
basis-only calculation never changes the stock's native execution price.
Fidelity shorthand option symbols normalize only inside the ledger/proof; raw
capture symbols and immutable content hashes are preserved.
These rules do not expand first-baseline authority: a newly bound account whose
existing holdings differ still needs a separately reviewed migration.

Newer broker observations still block an older capture. The only excluded rows
are derived snapshot-job valuations with the writer's exact deterministic identity:
`id = 'snap-' || account_id || '-' || taken_at`. This is not a clock-window or
value heuristic; UUID broker snapshots and every unclassified legacy row remain
fail-closed. No snapshot is deleted, backdated or rewritten to admit a capture,
and no provenance schema migration is required.

Policy is `{ bindings: [{ sourceId, last4, accountId }], ignoredSources: [sourceId] }`.
Review this mapping against the authenticated owner's account inventory out of band.
Every captured source needs an explicit binding or ignore entry; unmapped sources
are held. A binding is pinned durably on its first successful import and cannot
silently migrate to a different account. Additional fields are rejected.

The returned private receipt contains `receiptId`, `captureDigest`, and `accounts`:
`{last4,status,reason?,added,rekeyed,duplicates,audited,activityTypes?,baseline?,baselineCashAdoption?,bridgedBaseline?,bridgedRowCount?}`. No symbol, security value,
description, account number or balance is returned. `held` is an explicit refusal
for that account, not success; safe accounts may still commit in the same atomic
transaction. An unexpected error rolls back **all** accounts and the receipt.
Optional `activityTypes` counts classify **all observed input activity**, including
pre-cutoff rows, independently of newly audited keys. They contain only fixed
type names and nonnegative integer counts; their sum equals the input account's
activity count. Old receipts without this optional field remain valid.
`baseline` and `baselineCashAdoption` are optional booleans marking the first
successful verified baseline and whether authoritative native cash was adopted.
They never expose either cash value; ordinary incremental receipts/replays do
not report a new baseline or repeat cash adoption.

## Standard-input mode (for your own capture tooling)

The fixed entry point is `tools/holdr-investing-sync/cli.mts`. With `--stdin`, your capture tooling pipes a job
envelope to the command, for example through an SSH key on another computer of yours that is restricted to this one
command. The command line, never the envelope, supplies **all** database, policy and backup paths:

```sh
npm exec -- tsx tools/holdr-investing-sync/cli.mts --apply --stdin --db PRIVATE_DB --policy PRIVATE_POLICY_JSON --backup-directory PRIVATE_EXISTING_BACKUP_DIR --control-root PRIVATE_CONTROL_DIR
```

Stdin must contain exactly `{jobId,capture,heldSources,heldActivity,cancelled,boundaryRows}`.
`heldSources` is `[{sourceId,last4,reason:'unsupported-fidelity-holding'}]`;
`heldActivity` is `[{sourceId,activity}]` with the same strict activity-row schema,
and may reference only a held source, never an applied account. Counts are
nonnegative safe integers. Each source and activity identity is unique.

`jobId` is SHA-256 of UTF-8 canonical JSON of the **entire envelope excluding
the jobId field itself**. Canonicalization recursively sorts object keys by
JavaScript code-unit order, preserves array order, and emits compact JSON without
a newline. `fidelityInvestingDigest` is exported for Node/TypeScript callers.
This digest checks identity/integrity, not authorization: what may run the command
(such as a restricted SSH key), the private policy and local file permissions remain
the authorization boundary.

The JSON response is `{jobId,captureDigest,status,accounts,heldSources,heldActivity,cancelled,boundaryRows}`.
The held fields here are **counts**, not payload rows.
`status` is `complete` only when every supplied account was applied or explicitly
ignored and there are no unsupported held sources; otherwise it is `held` with
exit code `2`. All-unsupported captures produce a durable held receipt with no
fabricated accounts. Empty captures with no held sources are rejected.
Job identity (also the envelope digest) and transport counts are stored alongside
capture/policy digests in the same receipt transaction as ledger changes. A
repeated job adds zero ledger rows and emits another durable receipt.

## Local CLI

Run from the repository root with dependencies and the shared workspace built:

```sh
npm exec -- tsx tools/holdr-investing-sync/cli.mts --apply --db PRIVATE_DB --capture PRIVATE_CAPTURE_JSON --policy PRIVATE_POLICY_JSON --backup-directory PRIVATE_EXISTING_BACKUP_DIR --control-root PRIVATE_CONTROL_DIR
```

The DB must already exist. The backup directory must be owner-private and writable
(POSIX backup files are created mode `0600`). All fixed paths must be absolute,
canonical existing paths, with no symlink aliases or hard-linked files. Backup
and control directories must be owned by the current UID with mode `0700`; the
policy is read using the existing private-file checks (UID, `0600`, one link,
no symlink, bounded size). No browser payload may supply configuration paths.

The production CLI requires macOS's existing native lifecycle protocol. The
mandatory `--control-root` is passed to `withWriterLease`: shared
`lifecycle.lock` plus exactly `normal` marker **before any database open**,
including the initial read-only backup. The lease lasts through both backups,
import transaction and repository close. Maintenance, a busy exclusive lease,
missing/corrupt marker or unsupported platform refuses without opening the DB.
Inherited lease environment variables are rejected by the standard helper.
Run the command on the macOS host that owns the database.

The CLI performs a SQLite online backup before opening the repository, and the
importer performs another immediately before its own schema/writes. The CLI's
backup is read back before the repository opens: every table with its row count
must equal the database's, as counted in the read transaction the backup copies
(better-sqlite3 takes a backup's first busy step as done and can leave an empty
file). A backup that differs stops the run before the import, an exit `1`, and
its file stays. The CLI prints only
account statuses, last four digits, fixed reasons and counts. Exit codes: `0` all
applied/ignored, `2` one or more held, `1` validation/backup/database failure,
`3` maintenance, `75` busy lifecycle lease.
No live data should be written during development.
Synthetic subprocess tests inject the lease and policy-file reader through the
programmatic runner only; the shipped CLI exposes no bypass flag or environment
switch. Native lock behavior is provided by the existing lifecycle implementation,
not emulated by this importer.

## Incremental reconciliation (default)

The CLI always uses incremental mode. The service also defaults to incremental.
For the approved bound accounts, the first Sync establishes a **capture-time
baseline** only when current Holdr positions match current native Fidelity
positions per symbol and quantity within share-rounding (`1e-8`). A mismatch
holds as `baseline-holdings-mismatch` unless the separately authorized T0 bridge
below proves every gate: otherwise no cash adoption, key coverage or source
watermark is written. An empty ledger cannot automatically backfill a nonempty
broker account.

At a verified baseline, **all observed native activity keys**, including the
boundary day, are durably covered with immutable content digests and
`baseline-covered` classification. They do not become historical transactions.
Missing historical prices and opaque legacy rows cannot force a five-year
rewrite. Initial `audited` counts these newly covered keys; replay is zero.

The owner-approved native cash adoption is specific to this verified baseline:
when holdings match, Fidelity's authoritative cash replaces Holdr's cash.
The original Holdr cash, adoption flag, baseline capture instant/digest, and
proven ledger digest are saved privately in the same SQLite transaction.
Only `baseline: true` and `baselineCashAdoption: true|false` reach the receipt.
No cash snapshot prerequisite or blanket current-calendar-day hold is needed.
Normal freshness/conflicting-observation gates still apply.

The narrow **bridged baseline** is available only for a first incremental source
whose current holdings mismatch. T0 is the latest provable end-of-day boundary
where native holdings rolled back by all later native rows equal stored Holdr
holdings per symbol (the existing `1e-8` share-rounding tolerance). T0 must be
on or after the latest stored transaction or cash activity/history date, including imported snapshots,
and inside complete native coverage. Date-only rows never justify an intraday
cutoff or overlapping legacy activity. No stored transaction is rewritten.

Every row in `(T0, capture]` must prove an explicit native trade, assignment,
expiration, core settlement/income, or recognized cash movement. Exercise,
splits, transfers and unknown quantity events are not bridge-authorized.
An anchored native `DIRECT DEBIT` type/prefix qualifies only with exactly zero
quantity and fees, strictly negative NET, USD account currency, and a null or
recognized core/cash symbol. Security symbols and near-miss prefixes hold.
This T0-only evidence rule leaves cash rows as audit records, not transactions.
Bridged security additions retain the normal activity-addition history
invalidation. The economic-cash write also retains the shared cash-correction
invalidation when old stored cash differs from observed cash by more than two
cents, using the account's last pre-capture observation day (or the capture day).
That chart correction is separate from the bridge's residual cash-adoption flag:
even fully proven native flows can change the stored cash used by older snapshots.
Trades require native
positive execution price, signed quantity/NET agreement, fees and option metadata
where applicable. Lifecycle events retain the existing unique stock-leg,
strike/contract and unknown-basis proofs. Lifecycle option closes cannot open or
cross a position. Unknown quantity rows, inferred execution prices, missing native
valuation/pending evidence and unsupported cash descriptions hold. The projected
ledger must also pass all ordinary visibility, ordering, basis and snapshot gates.

Stored cash plus bridged native cash flows must match core plus signed pending
within the unchanged absolute `$0.02` tolerance; otherwise the existing authorized
baseline cash adoption is explicitly marked, not reported as proven cash flow.
The original cash, native flow delta, adoption decision, T0, row count and capture
digest are retained only in private SQLite audit tables. The value-free receipt
adds `bridgedBaseline: true` and `bridgedRowCount` (all post-T0 rows, including cash).
Only this explicit bridge can combine `baseline: true` with security additions;
an ordinary baseline still requires zero additions/rekeys/duplicates.
Pre-T0 observed keys are covered, while post-T0 keys are classified as imported
security or audited cash. Replay adds/audits zero, and a later unseen key on or
before T0 holds as `bridged-baseline-overlap`, never silently overlaps legacy rows.
This is not a general historical backfill, rekey or quantity plug.

The initial baseline instant/digest and boundary day are persisted separately
from the latest verified source observation. Later Syncs import **only unseen
native keys**, not rows selected by a recomputed date cutoff. Same-day new
activity is therefore retained, including on the initial boundary day; replay
of a covered historical key never fabricates a ledger row. Changed content under
any covered key holds. Established captures must cover the prior observation
day through the new one in `America/New_York`, preserving native-key
overlap/dedupe across UTC midnight and daylight-saving transitions. Retained
adjacent-day boundary coverage is permitted; UTC instants still govern capture
freshness and ordering.

#### Exact-content key drift

In incremental mode, a previously audited activity row may acquire a different
native key (for example, a later `txnNum` identity replacing a content-hash key).
An unseen key is recognized as the same row only when substituting a canonical
audited key reproduces that row's **immutable full content digest**. No date,
description, symbol, quantity, price, NET amount or fee may differ. Matching is
source-local, uniquely one-to-one, and requires the original key to be absent
from the incoming capture. Multiple historical candidates, competing new keys,
or old/new alias coappearance hold as `activity-key-content-conflict`; identical
legitimate rows are never collapsed to choose a convenient match.

The additive `fidelity_investing_activity_aliases` table links each new key
directly to the original audit identity. Both keys retain their own raw-row
content digest and original classification in `fidelity_investing_activity`;
original ledger fingerprints, baseline provenance and capture digests are not
rewritten. New aliases count as newly `audited` keys, not `added` or `rekeyed`
transactions. Security duplicates resolve to the original ledger fingerprint;
baseline-covered twins remain covered without adding historical transactions.
Cash/non-security twins do not contribute cash a second time, while genuinely
new cash rows still must reconcile. Alias replay, later key drift, or a sole
return of the original key reuse the same canonical identity. Changed content
under an already audited key always holds.

Aliases are persisted only after all existing ledger, coverage, holdings, cash,
valuation and snapshot gates pass, in the same transaction as the audit and
receipt. A held account writes no aliases or partial financial changes; an
unexpected write failure rolls everything back. This is not a backfill,
economic-match heuristic, guard relaxation or authorization to change history.

**Applying the fix:** an ordinary **next Sync** creates a new capture instant and
job identity, so it reaches the importer and can recognize these twins while
retaining normal coverage/freshness checks. Enqueuing the *identical* previously
held envelope does **not** retry it: the receiver returns its durable held
receipt, and its worker processes only queued/retry jobs. The importer itself
does not cache held results and can reevaluate a directly resubmitted capture
if still fresh, but any such operator action needs separate authorization.
Do not edit an envelope, its hashes or a held receipt, reset the outbox, or widen
history to trigger this fix. No backfill is required.

Changed/deleted legacy or imported ledger rows and external cash corrections
hold rather than silently re-anchoring or adopting cash again. The source
watermark, initial baseline, ledger/cash proof, audit and receipt commit
atomically. Held/ignored accounts and rolled-back writes never advance them; a
lost-response retry adds zero rows and audits zero new keys. Earlier development
schemas without the baseline audit columns require a reviewed migration, not
defaulted provenance.

After baseline establishment, visible baseline positions plus new activity must
match the broker per symbol, and proven cash plus new economic cash impacts must match captured cash within
two cents. Core sweep purchases/redemptions and core reinvestments move money
inside cash and are not counted twice. Core dividends/interest do increase cash;
unknown core quantity events or fee-bearing core settlements hold. A security
purchase plus its core redemption, an external cash deposit plus its core
purchase, and a core dividend plus its core reinvestment are distinct cases.

All legacy IDs, notes, fingerprints and economic values remain untouched.
The shared portfolio view hides `pos:*`/legacy `imported` snapshot transactions
when native same-symbol activity exists. If adding a row would newly hide a
visible baseline, incremental mode holds as `incremental-baseline-would-be-hidden`
instead of rekeying, deleting or disguising that baseline. Already-hidden rows
remain unchanged; net proof uses exactly the shared view's visible ledger.
Snapshot-only symbols unaffected by new native activity may remain baselines.

### Price and quantity-event rules

Parser-confirmed option metadata/multipliers remain mandatory. Apart from the
explicit split rules below, a positive execution price takes precedence even
when NET amount is zero and uses the supplied fees. Otherwise, nonzero quantity and NET
amount establish an effective unit amount `abs(amount)/abs(quantity)` (also
divided by the option multiplier for premium per share), with ledger fees zero:
the NET amount has already accounted for them. The original row, including
original fees, remains bound by its immutable content digest; retain the source
capture privately as the human-readable evidence.

A named positive stock-split delta can enter at zero unit cost only with an
existing positive non-option holding and zero amount/fees, preserving total
basis. Reverse splits are not ordinary sales and hold. In-kind transfers,
RSU/ESPP deposits and reinvestment quantity-only events may use captured total
basis only when exactly one event introduces the **entire new holding**, no
prior ledger row exists for that symbol, quantity matches and basis is
nonnegative. No historical lot allocation is inferred from current total basis.
Ambiguous multi-lot/existing-holding deposits, outgoing transfers and unknown
quantity-only types hold as `quantity-only-basis-unproven`, with per-type counts.
No guessed FMV, generic-deposit-to-RSU relabeling or network price lookup occurs.

## Separately gated full-history migration

Five-year capture remains a source-read window, **not** an instruction to
rewrite five years of ledger history. A new/held source may still force a full
combined bank read; established verified sources retain the seven-day overlap.
The receiver advances only a corresponding verified applied-account cursor,
even if another source makes the overall receipt held. Held/ignored sources do
not advance. Counts survive receipt sanitization without raw activity details.

The original full-backfill implementation is retained only behind the explicit
programmatic service option `mode: 'full-backfill'`; the production CLI exposes
no flag for it. It still requires its original full-history provenance and
reconciliation gates below, and refuses an already incremental source. A source
previously written by the old full-backfill importer also requires a separately
reviewed cutoff rather than silently changing modes. A real backfill/migration
requires its own authorization, proof and copy rehearsal; it is not this Sync.

## Shared safety and full-backfill gates

The importer validates and detaches input before its asynchronous backup. After
backup it obtains `BEGIN IMMEDIATE` and revalidates connection/external-write
generations, then plans against the locked current ledger. A concurrent mutation
during backup causes an explicit retry refusal. Captures older than 24 hours or
more than one minute in the future are rejected; per-source watermarks also
prevent rollback and conflicting same-instant observations. Before replacing cash,
the importer checks the account update timestamp as well as snapshot freshness;
it distinguishes its own prior write from an independent later cash correction.

In explicit full-backfill mode, nonzero share activity becomes a signed transaction except core/cash symbols
`FDRXX`, `FZFXX`, `SPAXX`, `FCASH`. Missing symbols or positive execution prices
hold the account; no guessed FMV, zero-priced success, or network lookups.
Option metadata uses the existing activity parser and must agree with the symbol.
Rows with a native key already present must match exactly. Legacy rows
are matched as an **exact economic multiset** (date, symbol, signed quantity,
price, fees, currency and option metadata) **and** must have a legacy bridge
fingerprint reproducible using the existing `activityParser.computeFingerprint`
and the captured action. They are consumed once and rekeyed while preserving
IDs, notes and economic values. Hash-shaped alone is not proof: opaque legacy
families and unfingerprinted/manual overlap stay held, never relabeled.
No row is deleted. Unmatched existing
activity inside the capture coverage holds the account rather than blindly
replaying history. Rows outside coverage remain in the projected ledger.
Because v1 carries no execution timestamp or guaranteed intraday ordering, adding
a transaction opposite another same-symbol, same-day transaction holds the account
as `same-day-execution-order-unproven`. A date-only history cannot safely establish
the buy/sell order used by the existing cost-basis aggregator.

In full-backfill mode, `pos:*` and legacy fingerprint-free `imported...` synthetic baselines hold the
whole account pending a separately reviewed migration. This tool never deletes
them or attempts to infer which old rows are disposable.

Raw projected share totals must match all captured holdings, including detecting
negative equity positions hidden by the UI aggregator. The shared portfolio
aggregator must also accept the ledger. Captured market values must reconcile to
the total; conflicting existing same-instant snapshots hold the account.
Successful imports update account cash and write a broker-observed account
snapshot through `createSnapshotRepo` (snapshot cost basis includes cash, matching
the existing snapshot job). That snapshot observes only the accounts the capture
read, so household and multi-account charts leave it out and chart only moments
that observed every account. Newer existing observations hold older captures.
Historical activity additions create a
history-invalidation record; old snapshots are never rewritten. So does adopting
the broker's economic cash when it differs from Holdr's by more than two cents: effective
the market day of the account's last snapshot before the capture (still holding
the old cash), or the capture's day, so those snapshots read as captured before
the sync instead of as a gain or loss in 1D or 1W. A chart whose own last point
before the correction is older, such as a household chart that left out a tick
observing only some accounts, starts it at that point's day: no return is ever
measured across a cash correction. Baselines applied before this
rule existed get the same record from the one-off, reviewed repair
`npx tsx apps/api/src/cli/cashAdoptionBackfillMain.ts` (a dry run; back up with
`npm run holdr-backup`, then run it again with `--apply`).

Cash/non-security rows are retained as immutable key/content-digest audit records,
not guessed into typed cash events. This deliberately avoids double-counting old
cash events under incompatible legacy identities. Trade amounts/descriptions
likewise stay out of audit tables; capture and policy digests, receipt counts,
per-activity content digests and classifications establish provenance. Keep the
original capture privately if a human-readable source record is needed.

Receipts, watermarks, activity audit, transactions, cash and snapshot changes
commit together. Re-importing an unchanged capture adds **zero** transactions,
rekeys zero rows, and audits zero new activity keys; it creates a new durable
receipt but does not overwrite cash or snapshots. Held accounts can be retried
with the same capture after a reviewed policy/ledger correction.
