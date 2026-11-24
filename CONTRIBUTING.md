# Contributing

Thank you for helping. Holdr handles personal financial data, so changes are held to two rules above all: never commit
real data, and never weaken an import's checks.

## Setup

Node.js 22 (22.3 or later; see [Getting started](docs/getting-started.md#1-install-nodejs-22-and-git)) and Git, then
(Windows PowerShell and macOS zsh alike; in Windows PowerShell 5.1 type `npm.cmd` and `npx.cmd`, or allow local
scripts once with `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`):

```powershell
npm ci
npx playwright install chromium
npm run holdr-user -- add dev --data-dir apps/api/data
npm run dev
```

`npm ci` builds `packages/shared` too. `npx playwright install chromium` downloads the browser that the web app's
Playwright tests (part of `npm test`) and `npm run test:e2e` drive; `npm ci` does not. `npm run dev` runs the API and
the web app with hot reload against the development database in `apps/api/data` (Git ignores it). `npm run demo` gives
you a seeded synthetic household instead.

## Checks before a pull request

```powershell
npm run typecheck
npm run build
npm test
git add -A
npm run privacy:scan
```

The same commands work in PowerShell and zsh. `npm run build`, `dev`, `lint`, `test`, `typecheck` and `clean` run
Turborepo through `scripts/turbo.mjs`, which turns off its anonymous telemetry and its update check
(`TURBO_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `TURBO_NO_UPDATE_NOTIFIER=1`); if you run `npx turbo` yourself, set
those variables or run `npx turbo telemetry disable` once. While you work, run the smallest relevant test:

| Area | Command |
|---|---|
| API (Vitest) | `npx vitest run --root apps/api src/<path>.test.ts` |
| Shared package | `npm test --workspace @finance-tracker/shared` |
| Web unit tests | `npm run test:unit --workspace @finance-tracker/web` |
| Extension unit tests | `npm test --workspace @finance-tracker/extension` |
| Scripts | `node --test scripts/<name>.test.mjs` |
| Card sync agent | `npm run test:agent` |
| MCP server | `npm run test:mcp` |
| End-to-end (Playwright, synthetic data) | `npm run test:e2e` |

Platform notes: tests that need macOS (`O_SHLOCK` locks, the native path checker, POSIX modes) skip elsewhere, and
Windows-only tests skip elsewhere. On Windows, run the tests from a normal (not elevated) shell: files an elevated shell
creates belong to Administrators, which the owner-only ACL checks rightly refuse.

## The privacy scan

`npm run privacy:scan` checks exactly what you are about to commit, the staged index, and fails when anything is
unstaged or untracked, so stage first (`git add -A`). It reports a file path and a category, never the matched text (a
path segment that holds a match shows as `***`). In file contents and in file paths it always looks for secrets
(Holdr's `holdr_agent_` tokens included), private keys, SSH keys, home-folder paths, e-mail addresses, private IP
addresses and tailnet names, card numbers and social security numbers. It also refuses Holdr's token and pairing-key
files (`service-token`, `agent-token`, `local-key.json`), databases and other risky file types, and large or binary
files. The only images allowed are PNG and WebP files of at most 1 MB in `docs/assets/brand/`,
`docs/assets/screenshots/` and `apps/web/src/assets/brand/`, and only without metadata: no text, EXIF, XMP, ICC
profile or time chunks. SVG files are scanned as text and may not embed data URIs. Take screenshots from the demo only
(see [docs/brand.md](docs/brand.md#screenshots)).

Personal names and other identifiers belong in a private, git-ignored list, never in the repository: put one per line
in `.privacy-scan.local` (lines starting with `#` are comments) or, comma-separated, in the `PRIVACY_SCAN_BLOCKLIST`
environment variable. Save the file as UTF-8. In PowerShell, write it with
`Set-Content -Encoding utf8 -Path .privacy-scan.local -Value 'first term', 'second term'`, not with `>`, which Windows
PowerShell 5.1 writes as UTF-16; in zsh, `printf '%s\n' 'first term' 'second term' > .privacy-scan.local`. A term the
scan cannot read (another encoding, a control or invisible character) stops it and names the line. Terms shorter than
3 characters are ignored. A term matches whatever its letter case and accents, and also when its words are joined
differently (`First_Last`, `first.last` and `FirstLast` for `first last`), wrapped across lines, percent-encoded or
base64-encoded. `npm run privacy:release` requires such a list. `node scripts/privacy-scan.mjs --worktree` scans the
working tree instead, and `--tree <commit>` a commit.

## Privacy requirements

- Use generated or clearly synthetic fixtures.
- Never commit real statements, exports, databases, receipts, screenshots, names, addresses, e-mails, phone numbers,
  account endings, private host names, machine paths, credentials or tokens.
- Use reserved example domains (`example.com`, `holdr.example.ts.net`) and documentation IP ranges.
- When you find a new kind of sensitive data, add a rule to `scripts/privacy-scan.mjs` and a test for it.
- Importer bug reports need a minimal synthetic reproduction.

## Code changes

- Keep imports preview-first, and refuse ambiguous or incomplete financial data rather than guess.
- Keep API errors and logs free of financial values.
- Add focused tests for changed behavior, and update the documentation it touches.

## Licensing

By contributing, you agree that your contribution is licensed under the repository's MIT License.
