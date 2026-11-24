# Security policy

## Supported version

Security fixes are applied to the latest `main` branch. Older commits are not maintained as supported releases.

## Reporting a vulnerability

Use GitHub private vulnerability reporting or a private security advisory for this repository. Do not open a public issue containing credentials, financial data, account identifiers, private hostnames, or reproduction files copied from a real provider.

Include:

- affected commit
- component and route
- impact
- minimal reproduction using synthetic data
- any safe mitigation already tested

## Deployment expectations

FinanceTracker is intended for a trusted person or household on a private host.

- Keep the API on loopback.
- Use the documented Tailscale Serve HTTPS path for other devices.
- Never enable Tailscale Funnel or expose the API directly to the public internet.
- Protect the data, control, configuration, backup, and token files with operating-system permissions.
- Back up before upgrades or import changes.

## Secret handling

Never commit `.env`, `holdr.conf`, service and agent tokens, cookies, databases, statements, exports, or screenshots containing personal data. Run `npm run privacy:scan` before every contribution.

## Tooling privacy

The repository's build scripts (`npm run build`, `dev`, `lint`, `test`, `typecheck`, `clean`) run Turborepo through `scripts/turbo.mjs`, which turns off Turborepo's anonymous telemetry and its update check. Holdr itself has no telemetry.

## Dependency advisories

`npm audit --omit=dev` reports no known vulnerabilities in the packages Holdr runs with. A full `npm audit` still reports advisories in development-only test tooling, accepted until the test suite moves to a newer Vitest:

- `vitest` 2.x and what it brings along (`tinypool`, `@vitest/mocker`, `vite-node`, and its own copies of `vite` 5 and `esbuild` 0.21). The advisories concern the Vitest UI and API servers, browser mode, the Vite and esbuild development servers, and prototype-pollution gadgets in the worker pool. Holdr runs Vitest only as `vitest run`, in Node, on its own test files, with none of those servers or modes. Clearing them needs Vitest 4.1.12 or later, a major upgrade of the API test suite planned as a separate change.
- `esbuild` 0.27 (the extension's bundler, and `tsx`): the advisory concerns esbuild's development server (`esbuild --serve`) on Windows, which Holdr never starts.

Run `npm audit` again before you deploy an update.
