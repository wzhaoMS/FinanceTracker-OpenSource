# Amazon capture validators

These plain ES modules define the Amazon capture envelope (`holdr.amazon-staging`,
versions 1–3, with optional `holdr.amazon-fresh-item-lists` sections) and the rules
that every capture must satisfy before the API will stage it. The API loads them at
runtime from the repository checkout:

- `apps/api/src/services/amazon/capture.ts` imports `validateAmazonCapture` from
  `amazon-capture.mjs`.
- `apps/api/src/services/amazon/savedOrders.ts` imports
  `validateAmazonFreshItemLists` from `amazon-fresh-items.mjs`.

Because the API resolves these files relative to the repository root, a deployment
must include `tools/amazon-capture/` alongside `apps/api/`.

| File | Purpose |
| --- | --- |
| `amazon-capture.mjs` | Capture envelope, staging, readiness and continuation validators |
| `amazon-report.mjs` | Per-page report and navigation rules used by `amazon-capture.mjs` |
| `amazon-scoped.mjs` | Scoped readiness checks used by `amazon-capture.mjs` |
| `amazon-fresh-items.mjs` | Amazon Fresh / Whole Foods item-list validator |
| `fixtures/amazon-capture.mjs` | Synthetic capture builders used by the API tests |

The browser tooling that produced captures for the original deployment is not part
of this repository. Any producer you write must emit envelopes that these validators
accept; the API refuses everything else. All fixture data is synthetic.
