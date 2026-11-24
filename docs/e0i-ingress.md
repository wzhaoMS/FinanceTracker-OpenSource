# Staged upgrades of the hardened macOS deployment (advanced)

> [!WARNING]
> This page is for the hardened macOS deployment only ([setup D](deployment.md#d-advanced-hardened-macos-deployment)),
> and it is **advanced and unsupported**: the procedure was written for its original author's machine and assumes the
> bundled start script's layout (`~/Holdr/FinanceTracker`, `~/bin/start-finance-mac.sh`). Everyone else upgrades with
> the [plain steps](getting-started.md#9-upgrade-or-go-back-to-an-older-version).

This is the staged upgrade procedure for the macOS host scripts. Read [Deployment](deployment.md) first: it covers
single-checkout installs and the manual upgrade and rollback, and explains why `dist` mode stays closed until a reviewed
Tailscale build is pinned.

Placeholders: `C` is the full 40-hex source commit being deployed, and the staging directory is `~/holdr-staging/C`;
substitute the commit before running a command. `T`, `STAMP`, `SNAP`, `K` and `KC` are shell variables that section 2
sets: the live tree, the snapshot's time stamp and folder, and the rollback kit (`rollback-kit.sh prepare` makes it as
`~/holdr-rollback/<STAMP>/FinanceTracker`, with its configuration `~/holdr-rollback/<STAMP>/holdr.conf`). Run sections 2
to 4 in one zsh or bash session, or set the variables again (with the same `STAMP`) in a new one.

## 1. Stage the candidate (nothing live changes)

1. Export the commit and extract it: `git archive --format=tar C > holdr-C.tar`, then extract it into
   `~/holdr-staging/C/FinanceTracker/`.
2. Right after extraction, before `npm ci`, record the archive:
   `bash ~/holdr-staging/C/FinanceTracker/scripts/deploy-apply.sh --record-archive` (writes `~/holdr-staging/C/archive.sha256`).
3. In the staging tree build everything the live tree will need. An extracted archive has no `.git`, so the commit is named:

   ```sh
   npm ci
   npm run build --workspace @finance-tracker/shared
   npm run build:release -w @finance-tracker/web -- --commit C
   npm run build:native -w @finance-tracker/api -- --commit C
   ```

   Note the release digest and the `commit` and `manifest` values that `build:native` prints.
4. Write the candidate configuration `~/holdr-staging/C/holdr.conf` (mode `0600`) with that release digest and the two
   native pins (see the `holdr.conf` keys in [Deployment](deployment.md)).
5. First deployment only:
   `HOLDR_CONFIG=~/holdr-staging/C/holdr.conf npm --prefix ~/holdr-staging/C/FinanceTracker run holdr-recovery -- init`.
6. Staged preflight, with `HOLDR_ROOT` unset or naming the live tree's parent:
   `HOLDR_CANDIDATE=~/holdr-staging/C/FinanceTracker HOLDR_CONFIG=~/holdr-staging/C/holdr.conf bash ~/holdr-staging/C/FinanceTracker/scripts/start-finance-mac.sh --preflight`
   must print `PREFLIGHT ok`.

## 2. Backup, snapshot and rollback kit

```sh
T="${HOLDR_ROOT:-$HOME/Holdr}/FinanceTracker"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAP="$HOME/holdr-snapshots/$STAMP"
K="$HOME/holdr-rollback/$STAMP/FinanceTracker"
KC="$HOME/holdr-rollback/$STAMP/holdr.conf"
HOLDR_CONFIG=~/holdr-staging/C/holdr.conf npm --prefix ~/holdr-staging/C/FinanceTracker run holdr-backup -- --tree "$T"
bash ~/holdr-staging/C/FinanceTracker/scripts/rollback-kit.sh snapshot --snap "$SNAP" --tree "$T"
bash ~/holdr-staging/C/FinanceTracker/scripts/rollback-kit.sh prepare --snap "$SNAP" --stage ~/holdr-staging/C
```

`snapshot` records the code, `~/bin/start-finance-mac.sh`, the live `holdr.conf` (or its absence) and
`tailscale serve status --json`, then tests restoring them. `prepare` clones the staging tree into the new kit `K`, copies
the candidate configuration as `KC`, runs every check of `rollback-kit.sh verify`, and ends with
`rollback kit ~/holdr-rollback/<STAMP> verified`. A kit is never reused.

## 3. Apply (the only live change)

```sh
HOLDR_CONFIG="$KC" npm --prefix "$K" run holdr-lifecycle -- enter --reason deploy
~/bin/start-finance-mac.sh --stop
HOLDR_CONFIG="$KC" npm --prefix "$K" run holdr-lifecycle -- exclusive --timeout 60 --leave -- \
  bash ~/holdr-staging/C/FinanceTracker/scripts/deploy-apply.sh --kit "$K"
~/bin/start-finance-mac.sh
```

`deploy-apply.sh --kit` copies the archive's files into `T` and checks every hash, removes the files listed in
`scripts/retired-files.txt`, swaps `node_modules` only if the lockfile changed, copies the web release, the native build and
`packages/shared/dist`, verifies the release, installs `~/bin/start-finance-mac.sh` and `holdr.conf`, and validates the tree
offline inside the lease. On any failure it reverts from `K` in the same lease and exits `4`, keeping the maintenance marker.

## 4. Rollback

Always verify the kit first, then restore from the kit only:

```sh
bash "$K/scripts/rollback-kit.sh" verify --snap "$SNAP"
HOLDR_CONFIG="$KC" npm --prefix "$K" run holdr-lifecycle -- enter --reason rollback
~/bin/start-finance-mac.sh --stop
HOLDR_CONFIG="$KC" npm --prefix "$K" run holdr-lifecycle -- exclusive -- bash "$K/scripts/deploy-apply.sh" --revert "$SNAP" --kit "$K"
HOLDR_CONFIG="$KC" npm --prefix "$K" run holdr-lifecycle -- leave --snap "$SNAP" --target-root "$T" --target-config "$SNAP/holdr.conf"
~/bin/start-finance-mac.sh
```

Use `--target-config none` when the snapshot recorded no `holdr.conf`. The revert restores `T`, the previous start script, the
previous configuration and the recorded Serve state. It does not touch the database: if the new code already ran, restore the
pre-upgrade backup as described in [Deployment](deployment.md#backup-and-restore) before starting the previous version.
