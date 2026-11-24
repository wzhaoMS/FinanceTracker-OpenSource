# Holdr card sync agent (experimental)

A browser extension and a small local receiver that save your American Express statements as redacted
`holdr.card-import` files for you to review and import in Holdr, on this computer only.

- Install, use, auto-start, update, uninstall and troubleshooting: [docs/sync-agent.md](../../docs/sync-agent.md)
- Run the receiver: `npm run agent` (that is, `node --import tsx agents/card-sync/receiver.mjs`); `npm run agent -- help`
  lists its commands
- Tests: `node --import tsx --test agents/card-sync/tests/*.test.mjs`

| Path | What it is |
|---|---|
| `receiver.mjs` | the receiver's entry point (`start`, `pair`, `check`, `outbox`, `help`) |
| `lib/` | the receiver: configuration, the loopback listener and encrypted channel, private folders, conversion, the outbox, read-only Holdr API calls |
| `extension/` | the unpacked Chrome/Edge extension (Manifest V3) to load in Developer mode |
| `install/windows/` | register, stop and remove the per-user Task Scheduler task |
| `install/macos/` | `render-plist.mjs`, which writes the per-user LaunchAgent |
| `tests/` | `node:test` suites with synthetic data only |

`extension/local-key.json` (the pairing key) is created on your computer and ignored by Git; never commit or share it.
