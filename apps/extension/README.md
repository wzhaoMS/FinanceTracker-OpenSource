# Holdr card-sync extension (developer preview)

> **Developer preview: it cannot connect as shipped.** This extension is a shell: the production build contains **no
> bank adapters**, so it would sync nothing, and the only Holdr it talks to is the hardened macOS `dist` deployment with
> the device API on (`HOLDR_DEVICE_API=1`), which stays closed (every request answers `503`) until a supported
> Tailscale build is pinned in `apps/api/src/ingress/attestation.ts` (see
> [docs/deployment.md](../../docs/deployment.md#d2-dist-tailscale-serve-to-a-unix-socket)). It is published for
> developers. To bring card activity in today, use the file import ([docs/importing-data.md](../../docs/importing-data.md))
> or the experimental [card sync agent](../../docs/sync-agent.md), which has its own, separate browser extension.

Holdr's own Chrome/Edge MV3 extension, written from scratch for the card-sync design
(item **E3**; [Design references](#design-references) explains these names). It is the shell every
issuer adapter plugs into: the trusted popup and options page, the in-page panel,
per-issuer permission and stop, three validation layers, one bank-read entry, trusted
storage and an exact preview. It speaks the frozen wire contract
(contract 1, defined in `packages/shared/src/cardSync/`) through `@finance-tracker/shared`.

What is **not** here yet:

- **Real issuer adapters** (E4–E7). The production build compiles in none, so it asks
  for no issuer site at all.

**Holdr's device API** is E2c (`apps/api/src/routes/cardSync/`). E3 talks to it only
through `worker/holdrClient.ts`, in the shapes of `contracts/holdrApi.ts`, aligned with
E2c's seven integration differences (M1–M7, see [Device API contract](#device-api-contract) below). The unit and e2e
tests run against a loopback fake Holdr that answers as E2c does; the acceptance suite
runs the production-id build against E2c itself (macOS).

## Design references

The extension was built to a card-sync design whose documents are not part of this repository. Its code comments and
tests still name the design's parts, and this page uses the E and M names:

| Name | Meaning |
|---|---|
| E0-I | The hardened macOS deployment's ingress and lifecycle design (`dist` mode, lifecycle locks, recovery) |
| E1a | The card-sync wire contract and payload builder (`packages/shared/src/cardSync/`) |
| E1b | The owner-side rules for synced card data: authorization, review and import, with numbered revisions |
| E2b, E2c | Holdr's owner routes for card sync, and its device API (`apps/api/src/routes/cardSync/`) |
| E3 | This extension shell |
| E4–E7 | The issuer adapters and the gates that admit them; none is written yet |
| E8-M | The owner's pairing, approval and review API and screens |
| M1–M7 | The seven integration differences between this extension and the device API (see [Device API contract](#device-api-contract)) |
| X*n*, Q*n* | Numbered decisions (X) and answered questions (Q) of the design review, cited in code comments |
| § *n*, plan § *n* | A section of the design documents, cited in code comments |

## Layout

| Path | What |
|---|---|
| `src/worker/` | MV3 module service worker: the only Holdr client, issuer settings, script registration, captures, trusted storage |
| `src/isolated/` | ISOLATED content scripts: the collector, `bankRead` (the single bank-read entry), the closed shadow-DOM panel, the shape relay |
| `src/main/observer.ts` | MAIN-world passive observer of the page's own fetch/XHR responses (passive issuers and shape mode) |
| `src/projection/` | Page-side projection, the stream store (merged as the wire contract says) and the v2 build |
| `src/popup/`, `src/options/`, `src/ui/` | Trusted extension pages, plain text only (`textContent`, no HTML sinks) |
| `src/contracts/` | Exact-key schemas for every message, the shape report and Holdr's device API (E2c) |
| `src/adapters/fake/` | Fake issuers for the test and acceptance builds only (`*.e3.test`) |
| `src/config/` | Build targets: `production.ts` (tailnet Holdr, no adapters), `test.ts` (fake hosts) and `acceptance.ts` (fake issuers, the synthetic `https://holdr.test`, the production id) |
| `build/` | esbuild per entry, manifests, and the build gates |
| `tests/unit/`, `tests/e2e/`, `tests/acceptance/` | node:test unit tests; Playwright extension e2e against the fake Holdr; Playwright acceptance against E2c |

## How a capture flows

1. **Enable an issuer.** The user enables it in options. They accept its risk notes,
   and for MAIN issuers a separate passive-observer consent, both tied to the adapter's
   consent version. The browser's own prompt grants that one site. The worker then
   registers the issuer's content scripts dynamically; the manifest has no static
   `content_scripts`.
2. **Page side.** The collector (ISOLATED) and, for passive issuers, the observer (MAIN)
   project issuer data in the page into `projected-bank-batch/v1`:
   - text goes through `prepareCardSyncRowText` with the stream's card hints;
   - amounts come from strings through the contract helpers;
   - ids go through `cardExternalIdHash`;
   - coverage is capped by `cardSyncCompletenessCeiling`.

   MAIN validation is advisory. ISOLATED re-validates every batch, then merges each
   account's batches with `mergeProjectedBatches`; that merge is authoritative.
   - **main-passive:** batches are incremental, and an exact re-observation is dropped.
     The observer reads a response only if its final URL is the request URL (any
     redirect, even to another path the contract allows, such as another account's, is
     ignored) and only under the route its request began in. An XHR answer is read when
     its request is done (`readystatechange` to DONE, before `load`, so before a page
     handler can open the XHR again); each request's listener ends at its own DONE, and
     one whose XHR was opened again since reads nothing.
   - **isolated-read and DOM:** a new read or snapshot of an account supersedes the
     earlier one.
   - **Navigation** (an SPA route or account switch, also one that only shows cached
     rows) drops the page's rows, account handles and built captures in every mode. A
     read running then is aborted and nothing it returns is applied, a partial result
     included. Route changes come from the Navigation API's `currententrychange`
     (`common/navigation.ts`), which the browser dispatches once to the MAIN observer
     and the ISOLATED collector alike; both count them with the same code, so their
     counts agree whenever page code runs. The observer binds each request to the count
     at its start, starts a new stream at every change and tags each batch with its
     count (`gen`); the collector takes a batch only under its own count. So an answer
     to a request begun before any route change (there and back included) never
     reaches the new page state, and one begun after it is never lost to a late reset.
     `popstate` and a poll remain as a fallback reset, outside that count.
   - **Sign-out** (a read refused as signed out, also after earlier pages of it, or the
     page turning into its sign-in view at the same address, which the collector's poll
     checks) drops everything the same way, the pages read before the refusal included.
     The MAIN observer is told (`reset`, which both sides add to the count), so an
     answer to a request begun under the earlier sign-in is never taken, even after a
     new sign-in. The page then counts as signed out, and nothing is read or built
     until it shows its sign-in view and then its activity again, or navigates. MAIN
     answers to requests begun after that reset (so under the new sign-in; a MAIN page
     signs out only through its sign-in view, as reads run only on pages without a MAIN
     observer) are held, at most 8, and taken once the activity shows: the collector
     looks at the page again when one arrives rather than waiting for its poll, so a
     page that loads its activity in the same moment it signs in loses nothing. A ninth
     would be lost for good (the observer has marked its page as seen), so then nothing
     of that sign-in is kept or built, and the panel and the popup say to reload; a
     navigation, a new sign-out (each starts a new stream in the observer too) or a
     reload starts afresh. A preview is built only on a page that shows its activity.
3. **Build the preview.** The user maps every (holder group, last four) to a confirmed
   Holdr card scope in the popup. ISOLATED then builds the v2 payload:
   - one candidate maps to one binding, and every row group to one of its confirmed
     scopes;
   - coverage is expanded with `expandCoverageToScopes` over **every** confirmed scope
     of the bound account, so a scope without rows says "read, empty"
     (`observed: null`) rather than "not read"; the worker checks that coverage names
     exactly those scopes;
   - `owner` is null and `cards` holds the confirmed scopes' last fours (with full
     coverage, all of them);
   - the build goes through `buildCardSyncPayloadV2`.
4. **Freeze.** The worker validates again (layer 3) and checks the payload against the
   capture. It then freezes `canonicalJson(payload)` and its `cardSyncPayloadDigest`
   (`pd1:`) in `storage.session`.
5. **Preview and send.** The popup reads those bytes straight from trusted storage,
   shows them, and recomputes the digest. It refuses to offer Send unless the text is
   exactly canonical JSON with that digest. Send carries only the digest; the worker
   sends exactly the frozen bytes: `{"payload":<frozen>,"runId":…}`.
6. **Retries and receipts.** On an unknown outcome, the worker asks Holdr for the
   receipt first, then retries at most twice with the same bytes and idempotency key.
   After Holdr's durable ACK, the local text is cleared. Planning and committing to the
   ledger are separate, explicit steps. Holdr answers a plan either with an executable
   plan (Commit is offered) or with `owner-review`: the owner decides in Holdr,
   nothing can be committed from the extension, and "Check with Holdr" later shows what
   the owner did. With contract 1's admissions all closed, every first sync gets
   `owner-review`; the fake Holdr answers that unless a test opens admissions.

### Stops and safety rules

- **The stop path.** Disable, the global pause, permission removal, a consent change and
  a shape change all share one path:
  - new reads and sends are blocked;
  - in-flight Holdr requests are aborted;
  - unsent data is dropped;
  - scripts are unregistered;
  - running collectors are told to stop, and they stop the MAIN observer.
- **The stop gate** (`worker/context.ts`). The first two happen the moment a stop is
  requested, before any await: in the command handler, in the
  `permissions.onRemoved` listener, or when a collector's shape-change report arrives.
  Storage catches up afterwards, serialized. Every piece of work takes a snapshot of the
  gate before its own first await: Holdr requests, reads, discovery, builds and
  collector messages. It checks the gate again after its last await, right before it
  dispatches anything. Holdr requests are also bound to the abort signal their issuer
  had when the work began, which every later stop of that issuer (or the kill switch)
  aborts. So nothing begun before a stop is dispatched after it, even if a resume
  follows, and nothing new starts between a stop and its storage update. Work a stop
  ended is named by that first stop: a later one (the permission removal a disable
  causes, say) does not change the reason Holdr hears, and neither does what storage
  shows after it (the gate is asked first after every read). A change the gate never
  saw is named by what storage shows: a contract paused on a site change, the site
  permission gone, or the issuer switched off. Only an enable that began after the stop
  lifts it. A stop of one issuer leaves another issuer's work alone.
- **The kill switch covers device traffic too.** Pairing, status checks and run aborts
  are refused while it is on. In the popup and the settings page, the kill switch never
  waits for, and is never disabled by, a command in flight; disabling one issuer never
  holds back the kill switch or another issuer's stop. Pages are told to stop the
  moment a stop is requested, before the serialized cleanup forgets them, so a read
  already running in a page ends at once.
- **Pages a stop could not reach** stay on record (`unconfirmedStops`) and in the UI's
  "close those tabs or disable the extension" warning until one answers a stop, the
  page shows up again (it is then told to stop; a reload starts it afresh) or its tab
  closes. They are recorded before the stopped documents are forgotten, so a worker
  ending in between loses none, and a page refused when it reports joins them if it does
  not answer either. Every later stop and every worker start tries them again, so a
  repeated cleanup (the permission removal a disable causes, say) never clears the
  warning without an answer. A page the worker no longer tracks is told to stop as soon
  as it reports; a collector therefore announces itself (role, page state "other") at
  document start, before its MAIN bridge can deliver anything, and its page state
  follows after DOMContentLoaded. Tracking is bounded (20 documents): one that leaves it
  to make room is told to stop first, like any stop. A page that is left (`pagehide`: a
  navigation, or the back/forward cache) stops both its collector and its MAIN observer
  for good, so a document a newer one replaced never resumes collecting.
- **Shape mode** holds its issuer's capture work (send, plan, commit) until it ends.
  Receipt checks and run aborts carry no capture data and may still run. Each page
  declares what it runs (`role`: collector or shape relay) in its first message: a
  shape relay is admitted only during a live shape mode of its issuer, a collector never
  during one, so a page that got its scripts just as the mode changed is told to stop.
  Ending shape mode unregisters its scripts before its pages are told to stop. A shape
  report is exactly what its contract's trusted metadata allows (the descriptor's
  `shapeContracts`): the contract's method and fixed path template, and only
  its confirmed names (query keys, header names, body and response keys). Any other
  key or header name, however it is spelled, is `<dynamic-key>`, since it may be an
  account id or routing material. MAIN applies this, and the ISOLATED relay and the
  worker refuse a report that is anything else.
- **Interrupted stops.** A worker that stops after storing a stop but before cleaning
  up finishes the cleanup at its next start: unsent data goes and pages are told to
  stop. A stop ends its issuer's shape mode first, durably: the record is marked ended
  before its page collectors are stopped and only then removed, so a restart in between
  finishes it. A shape mode survives a restart only for an issuer that may still record
  (with its site permission); an ended or expired one stops its page collectors.
- **Late answers.** A Holdr answer applies only while the capture is still in the stage
  that its step began from. A discard or a final receipt in the meantime wins. Receipts
  never move a capture backwards: a "nothing arrived" answer that a newer one overtook
  leaves a known acceptance alone.
- **A commit in flight** is never hidden by a discard. Closing the capture then stops
  further attempts and keeps the plan, so a receipt check can settle whether the commit
  landed (also after a worker restart). Close cancels further attempts the moment it
  arrives, whatever holds the worker's queue (a counted cancel each commit compares with
  the count at its own start), and the popup keeps Close usable while its own commit
  runs. A commit that went out without an answer (no answer, an unreadable one, or a
  stop) leaves the plan pinned (`commitUncertain`, also after a restart): no new
  capture, no new plan and no Close until Holdr's answer settles it (a receipt showing
  the commit, the same plan committed again, or a receipt asked for once the plan has
  expired at Holdr plus a margin, `planSettleMarginMs` in `config/timings.ts`). Expiry
  is judged when the receipt is asked for, never when its answer arrives, and a later
  definite refusal alone proves nothing then. A commit reads its credential in the same
  serialized step that marks it, and forgetting that credential or pairing another is
  refused while it could still settle a pinned capture, so no commit ever goes out with
  a forgotten credential. Until the commit's outcome is stored (a closed set's
  receipt included), the capture is not replaced and its plan is not re-planned. A final
  receipt seen meanwhile latches before any await, and every attempt checks both
  synchronously right before it is dispatched.
- **Uploads without an answer.** When an upload's answer never came (a timeout, a lost
  response, a success answer that breaks the contract, a stop, or the worker ending
  mid-send), the capture remembers it
  (`uploadUncertain`) across sends, receipt checks and restarts; a stop that drops a
  send whose run exists records it in the same write. While it is set, a later
  definite refusal is settled by the receipt, never taken as "nothing stored", and a
  "nothing arrived yet" receipt settles nothing either: without its bytes the capture
  stays checkable (`upload-pending`, with Close offered) unless Holdr had closed the run
  before that receipt was asked for (it acknowledged the run abort, or refused an upload
  as closed; a closure confirmed later does not make an older answer current). If the
  receipt cannot be read, the capture stays checkable. A stop during that receipt ends
  the send like any other stop: the bytes go and Holdr hears the abort reason.
- **Final answers win everywhere.** A final receipt (committed, rejected, review
  expired) ends the capture in any live stage of its run, a preview that another check
  restored included; it latches before it is stored, and sends, plans and commits check
  that latch synchronously right before they dispatch.
- **Credentials.** A 401 wipes only the credential it was answered for, never one that
  replaced it (forget and pair again). A capture belongs to the paired device it was
  made under: after forget and pair again, the new credential never acts on the old
  capture's run (Holdr would refuse another device's run anyway); the capture ends as
  `device-replaced`, and Holdr keeps what it accepted for review. Opting out of "trust
  this private browser" moves the credential off the disk before the setting changes;
  a credential found on disk after an interrupted opt-out is moved to memory (or
  dropped) at the next start and is never used from disk.
- **Shape drift.** A response that the adapter's contract no longer describes (a
  missing field, a changed type, an unknown enum) **pauses that adapter version's
  contract**. The UI then points to file import. Enabling stays refused
  until a release with another adapter version. Shape capture stays available, so the
  new form can be recorded. A collector's drift report stops the issuer's work the
  moment it arrives, and the contract pause is stored whatever becomes of the report
  (refused page, kill switch on), so the issuer is never blocked in memory only.
- **Read limits.** At most one read per issuer runs at a time, and requests are spaced
  issuer-wide: a read that ends (or is stopped) leaves a cooldown of one request
  interval, which the next read of that issuer waits out before its first request,
  whatever tab or reader it runs in. A read owns its page's state, and so its lease,
  until it ends: a preview cannot be built on that page meanwhile. A 429 pauses that
  issuer for 30 minutes. Reads stop on a repeated cursor, an empty page without an end
  marker, sign-in pages, timeouts and the run budget (`config/timings.ts`, pinned by a
  unit test).
- **Storage.** It is set to `TRUSTED_CONTEXTS` for both areas, so content scripts cannot
  read it. The device credential lives in `storage.session` unless the user opts in to
  "trust this private browser".
- **Network.** The worker reaches only the build's Holdr origin. It sends no cookies
  (`credentials: 'omit'`) and follows no redirects, and only the listed method/path
  pairs exist. The extension pages' CSP is fixed in `build/manifest.ts` (`default-src 'none'`, scripts, styles and
  images from the extension only, no forms or base URL), with `connect-src` set to that origin, and the build gate
  refuses any other.

## Build

The production build compiles in exactly one Holdr origin, your `dist` deployment's
`https://<machine>.<tailnet>.ts.net`, from `HOLDR_EXTENSION_ORIGIN`. It refuses to build
without it, and refuses an `http://` origin, a port or path, an address outside
`.ts.net`, a multi-label machine name or a placeholder such as `holdr.example.ts.net`.
From the repository root:

```powershell
# Windows PowerShell
$env:HOLDR_EXTENSION_ORIGIN = 'https://<machine>.<tailnet>.ts.net'
npm run build:production --workspace @finance-tracker/extension
Remove-Item Env:HOLDR_EXTENSION_ORIGIN
```

```zsh
# macOS (zsh)
HOLDR_EXTENSION_ORIGIN='https://<machine>.<tailnet>.ts.net' npm run build:production --workspace @finance-tracker/extension
```

Then open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, choose
**Load unpacked** and select `apps/extension/dist/production`. As shipped, the loaded extension shows its pages but
cannot pair: its `dist` deployment answers `503` until a supported Tailscale build is pinned (see the note at the top).

The other targets need no origin (run them in `apps/extension`):

```bash
npm run build:test         # dist/test, extension id icilknejhlhobkgcejnkbhbebnkfldmc (fake issuers only)
npm run build:acceptance   # dist/acceptance, the production id lmkonkgaegpbbdkngajdmlgghkchjdnc; fake issuers, Holdr pinned to https://holdr.test
```

The acceptance target (M6) exists because E2c answers CORS only for the production
extension id and takes device tokens only over its HTTPS entry. It keeps the production
key but compiles in only the fake adapters and the synthetic Holdr origin
`https://holdr.test`, which the production output may never name. The production id
appears only with the production or that synthetic Holdr origin.

Synthetic targets resolve `@finance-tracker/shared` to the narrow
`packages/shared/src/cardSync/extension.ts` contract entrypoint, not the
application-wide barrel. These are the same contract implementations, not
replacement validators or mock business logic. Unrelated catalog initialization
(such as Benefits product URLs) must not enter fake-issuer artifacts through
barrel-export side effects. Production resolution stays unchanged.
The unit build regression checks both synthetic targets in disposable output
directories so it cannot replace artifacts in use by an e2e run.

The build deletes its output if any gate finds anything. The gates check:

- **Sources:** AST rules over the sources (no dynamic code, no HTML sinks, storage only
  in the worker, …).
- **Bundle inputs:** only extension and shared sources go in. Node, API, fixtures and the
  offline import tool are refused, except the tool's pure span grammar `leaks.ts`, which
  the contract imports.
- **Bundle text.**
- **Manifest:**
  - permissions exactly `scripting` and `storage`, and host permissions exactly the
    Holdr origin;
  - optional hosts exactly the compiled adapters' sites;
  - no forbidden keys or permissions;
  - pinned keys per target;
  - `incognito: not_allowed`.
- **Mixing:** the production output may not name fake hosts, `localhost`, `http://` or
  `holdr.test`; the test and acceptance outputs may not name the tailnet or real issuer
  hosts, and the acceptance output not the test target's Holdr either.

## Tests

```bash
npm test                 # unit tests in tests/unit (node:test via tsx, scripts/run-tsx-tests.mjs)
npm run typecheck
npm run test:e2e         # builds the test target, then runs Playwright
npm run test:acceptance  # builds the acceptance target, then runs tests/acceptance
```

The e2e suite loads the built unpacked extension into Playwright's bundled
Chromium with `launchPersistentContext`:

- **Network:** fake issuers and the fake Holdr listen on loopback, on free ports. Every
  browser request goes through a local egress gate (`tests/e2e/support/gate.ts`). The
  gate maps `*.e3.test` to those ports and denies everything else, CONNECT included,
  and it is probed before each run. The fake Holdr resets before every test and drops
  any request an earlier test left in flight (a delayed or held one), so no test sees
  another's traffic.
- **Artifacts:** profiles, data and logs live under `.artifacts/card-sync-e2e/<run-id>/`
  in the repo; the tree ignores itself. Set `E3_E2E_KEEP=1` to keep profiles.
- **Browsers:** set `PLAYWRIGHT_BROWSERS_PATH` if Playwright's browsers live elsewhere.
- **Windows:** keep the repository path short. A Chrome profile path near `MAX_PATH`
  makes `storage.local` silently stall, which is why run ids and profile directories are
  short.
- **Real profiles:** the suite never opens a real Chrome or Edge profile.

Playwright's DevTools attachment keeps the MV3 worker from idling out. The harness
therefore stops the worker with CDP `Target.closeTarget`, as Chrome's own
termination-test guide does, and checks the stop and restart through the
`ServiceWorker` domain.

### Acceptance against E2c (M6)

`tests/acceptance` runs the acceptance build in the same Chromium setup
(`tests/e2e/support/browser.ts`), against Holdr's real device API:

- **Holdr:** `target.ts`, its own process, starts apps/api's `cardSyncDeviceWorld`
  (E2c's app, repository and device admission on a dist Unix socket; synthetic data
  only, in its own temporary directories). Holdr's clock is real time. The Chase-like
  source is enabled and bound to fake Chase's two cards. The owner's steps (create a
  pairing code, approve the browser, commit a set) are E2c's owner services, driven
  over JSON lines.
- **Transport:** a TLS stand-in for Tailscale Serve (`serve.ts`) fronts the socket
  with a throwaway P-256 certificate for `holdr.test` (`selfSigned.ts`). It forwards
  as Serve does: `Host: localhost`, `X-Forwarded-Host`, `X-Forwarded-Proto: https`, a
  tailnet `X-Forwarded-For`, and the browser's own forwarding headers dropped.
- **Trust:** the browser trusts exactly that key, through Chromium's
  `--ignore-certificate-errors-spki-list`.
- **Egress:** the egress gate forwards the fake issuers' plain HTTP and tunnels one
  CONNECT, `holdr.test:443`, to the stand-in. Everything else is refused, the
  production host's CONNECT included, and that is probed before the run. The browser
  resolves no name.

`acceptance.spec.ts` covers the whole path:

1. Pair with a real code and approve (M1, M2, M3).
2. Read, map, preview and send. Holdr's own payload digest must equal the previewed
   one.
3. The first plan is `owner-review` under contract 1. The owner commits in Holdr, and
   a receipt shows it.
4. The same rows again give an executable device plan, which commits once.
5. Closing an accepted capture records `user-cancelled` on Holdr's run.

Every Holdr answer must be 200, on the eight device routes only. It needs macOS, as the
device world does (E0-I lifecycle locks), so it is skipped elsewhere.

`transport.spec.ts` runs on every platform, with a loopback echo server behind the
same stand-in. It checks:

- the tunnel and the pinned key;
- that another throwaway key is refused;
- the production extension `Origin` and the absent cookie on a worker call;
- the forwarded headers.

### Scenario coverage

| Scenario | Spec |
|---|---|
| Signed in but not on the activity view; signed out; a 401 or login page after a read, also on a later page of it (the pages read before go too), and a sign-out in place (ISOLATED and MAIN), dropping what was read under that sign-in; a sign-in in place whose page loads at once keeps that first answer; answers that come while the page still shows its sign-in view wait for its activity, and more of them than can wait keep nothing of that sign-in and ask for a reload | `reads`, `controls`, `passive` |
| Manual paging, re-observation, Citi cache-only "load more", WF virtual list | `passive` |
| SPA account switch, also during a read (its partial pages are dropped), reload after missing `document_start`, two tabs (reads spaced across them; a preview is refused while a read holds the lease) | `controls` |
| MAIN-passive account switch showing cached rows, with an answer to a request begun before it arriving after; a cached switch there and back; an answer to a request begun before a switch there and back; a request made right after the URL changes; an XHR opened again after an abort, or inside its own load handler; a page request redirected to another account's path | `passive` |
| MAIN and ISOLATED branches; a passive page whose own data arrives before DOMContentLoaded (through pagination and a preview); a page left (pagehide) stops for good | `flows`, `passive` |
| Scope conflict | `reads` |
| Hostile page messages, site permission revoked, kill switch (device traffic included; finished at the next start when interrupted); a page no stop could reach stays reported until its tab closes; a drift report from a page that missed a stop still pauses the contract; a page leaving bounded tracking is stopped | `controls` |
| Worker stopped (idle and while sending) and restarted | `delivery` |
| Holdr offline, timeout, lost observation ACK, lost commit ACK, revoked device, forged digest, an upload answered off-contract or contradicting it; an unanswered upload stored late and then refused, settled from the receipt on the next Send; a kill switch during an upload still on its way, "nothing arrived yet" keeping it checkable (also when the worker stops with the pause stored, and when the run abort is confirmed after the receipt was asked for); a final answer reaching a preview another check restored | `delivery` |
| Disable, site access removed or a site change during an upload (with the run abort reason Holdr gets; the first stop names it, unit-tested); a stop during the last receipt check, or while a refused retry is settled; closing an accepted capture | `delivery` |
| A set the owner rejected, before and after a plan, and after a lost ACK; a late plan answer after a discard; closing a capture while its commit retries (also while a slow device check holds the worker's queue, and from the popup that started the commit); a commit refused as closed stays marked until settled; a plan answered `owner-review`, committed by the owner in Holdr; an owner commit while this browser holds a plan; commit answers that never came pin the plan until settled, and a receipt asked for before the pinned plan expired settles nothing even when it arrives after | `delivery` |
| Authority withdrawn in Holdr at upload, run creation, plan and commit, and a binding re-confirmed without re-granting this browser; a device revoked between run creation and upload; forget and pair again (no device acts on another's run; refused while a commit may still land); a credential lapsing after 30 days vs. revoked | `delivery` |
| pending → posted | `delivery` |
| Refund and two identical purchases | `flows`, `passive` |
| Repeated cursor (its coverage naming every confirmed scope of the account, the ones without rows as read and empty), empty page, 401/login page, 429, slow site, shape drift (ISOLATED and MAIN) | `reads` |
| Shape mode exporting zero financial values (a key or header named after routing material is `<dynamic-key>`; a report of well over a hundred entries); shape capture after a drift pause; capture work held while shape mode runs; a lapsed shape mode ended at worker start; a page with the scripts of the other mode is stopped | `shape` |
| Egress gate blocks non-loopback destinations | `flows` |
| M1–M7 against the fake Holdr's E2c answers: an extension update needing a new pairing, a capabilities origin other than this build's, refusals after the upload or the commit, limits that keep the preview, transport and availability refusals | `e2c`, `delivery` |
| The production-id build against E2c itself: pairing, upload, owner review and owner commit, device plan and commit, abort reason | `acceptance` (macOS) |

**Pending until E8-M exists, or not yet covered against E2c:**

- two browsers committing the same account against the real planner;
- the owner's pairing, approval and revocation UI (E8-M);
- pending→posted on the ledger side;
- restore, quotas and observation lifetimes against E2c.

**Manual:** branded Chrome/Edge loading of the fixed artifact, first with fake issuers
only.

## Device API contract

`contracts/holdrApi.ts` lists the routes and the exact request/response shapes of
Holdr's device API, E2c (`apps/api/src/routes/cardSync/`). Every response key is on
the contract's approved key list. Every success is `200`.

| Method | Route | Purpose |
|---|---|---|
| POST | `/card-sync/pairings/redeem` | `HoldrPair` auth; the only response with a bearer, read by a dedicated parser |
| GET | `/card-sync/capabilities` | Requires `holdrOrigin`, equal to this build's pinned origin (M2); a binding lists up to 39 card hints (M4). Read within E2c's bound on a device answer (256 KiB, 10,000 nodes): a full grant of 20 bindings passes the 64 KiB of the other, control-sized answers |
| POST | `/card-sync/runs` | `Idempotency-Key` equal to the body's `clientRunId` |
| POST | `/card-sync/observations` | The ACK's `status` is the set's state now (M7): `accepted-uncommitted` or `needs-review`, or, replaying an upload Holdr already has, the final `committed`, `rejected` or `expired-unreviewed` |
| POST | `/card-sync/imports/preview` | A strict union on `status`: `executable` (`previewId`, `payloadDigest`, `planDigest`, `expiresAt`, `counts`) or `owner-review` (`observationSetId`, `counts`, `reviewCount`, no `previewId` key). `counts` is the owner API's `PlanCounts`: exactly `insert`, `update`, `unchanged`, `aliased`, `matched`, `attributed`, `promoted`, `corrected`, `rejected`, `unmatched`, `superseded`, and no other key |
| POST | `/card-sync/imports/commit` | |
| GET | `/card-sync/runs/:id/receipt` | `acceptance`: `none`, `accepted-uncommitted`, `needs-review` (also Holdr's blocked and recovery reviews), `expired-unreviewed`, `rejected`; `ledger`: `none`, `committed` |
| POST | `/card-sync/runs/:id/abort` | body `{"reason"}`, one of `site-permission-revoked`, `not-signed-in`, `unknown-page-structure`, `certificate-error`, `user-cancelled`; anything else is 422 |

- **Authentication.**
  - Device requests use `HoldrDevice hdv1_…`.
  - A device sees only its own runs. Another device's run is `404 run-not-found`, and
    a set or plan it does not own is `404 not-found`. The fake enforces this at
    upload, plan, commit, receipt and abort.
- **Headers (M1).**
  - Every request carries `X-Holdr-Client: extension-v1` and `X-Holdr-Client-Version`
    set to the extension's own version, the redeem included.
  - Requests never carry a cookie (`credentials: 'omit'`) and follow no redirect.
  - Holdr ties a device to the version it paired with. After an extension update,
    the worker wipes the stored credential at startup (device status `outdated`) and
    the user pairs again; Holdr would answer the old credential 401.
- **Device label (M3).** A letter first, then letters, digits, space and `._-`, at most
  32 characters, as the API allows.
- **Error bodies.** `{error}`, plus value-free `issues` (at most 20) with some refusals
  (422, and some 400, 408 and 413), or `retryAfterSeconds` with 503 `unavailable`.
  Ingress refusals are bare `{error}`.
- **Error codes (M5).**
  - `HOLDR_ERROR_STATUS` lists every code a device can get, with the status E2c gives
    it: E2c's refusals, plus the ingress answers `authorization-blocked` (409),
    `ingress-unverified` and `ingress-refused` (503) and `device-transport-refused`
    (403). `bad-request` also comes as 408 (a stalled body) and 422 (an abort reason
    off the enum).
  - An error answer is Holdr's refusal only in that grammar, with a code Holdr gives
    that status (`holdrErrorStatusFits`). Any other JSON error answer (an unknown
    code, a known code with another status, another shape) is a protocol error: an
    unknown outcome, settled from the receipt. An error answer that is not JSON at all
    (a page from something in front of Holdr) keeps only its status: 502 and 503 are
    retried, and a 500 counts as unknown.
  - How the UI shows them:
    - Holdr's run, quota and rate limits: "limited";
    - `authorization-blocked`, the ingress codes and `unavailable`: "unavailable";
    - `credential-not-allowed`, `device-transport-refused` and
      `contract-unsupported`: "incompatible";
    - `plan-needs-review`, `capture-already-accepted` and `too-large`: each has its
      own text;
    - `scope-not-in-binding`: as an unknown binding.
  - `authorization-blocked` and any 500 may come after an effect landed, so they
    count as an unknown outcome, settled from the receipt.
- **Run aborts.**
  - When a stop ends a send after its run exists, the extension tells Holdr why:
    `site-permission-revoked`, `unknown-page-structure` (a contract paused on a site
    change) or `user-cancelled` (disabled, shape mode).
  - Closing a capture whose run Holdr may still hold open, or whose observation it
    accepted, sends `user-cancelled`. Holdr then keeps the accepted observation for
    review and records the reason on the run.
  - Aborts carry no bank data, so they also go for a stopped issuer. They never go
    while the kill switch is on; such a run just expires on Holdr's side.
  - E3 never sends `not-signed-in`: a run starts only when the user sends a frozen
    preview, after every bank read. Nor does it send `certificate-error`: a browser's
    fetch cannot tell a certificate error from other network failures.
- **Final receipts.**
  - Committed, `rejected` ("Holdr discarded this sync; capture again or use file
    import") and `expired-unreviewed` end a capture. It is never sent, planned or
    committed again. A final upload ACK (M7) ends it the same way.
  - A send, plan or commit refused because the run or set is closed (`set-closed`,
    `observation-expired`, `run-closed`, `run-expired`) asks for the receipt to learn
    why. The frozen bytes of such a send are dropped, never offered again.
  - A set the owner committed (or discarded) in Holdr is closed for the device too:
    its prepare is `set-closed`.
  - A commit of a plan made before the set changed is `preview-stale` (or
    `plan-mismatch`). That also asks for the receipt first, and offers to plan again
    only if the set is still open.
- **Authority at every step.**
  - What can refuse run creation, the upload, the plan or the commit:
    - Holdr's pause (`sync-paused`);
    - a disabled issuer or withdrawn MAIN consent (`sync-disabled`);
    - binding changes (`binding-stale`, `binding-needs-reconfirmation`,
      `binding-retired`).
  - A binding re-confirmation re-grants this browser only when the owner lists it.
    Until then the binding is `binding-stale` for it and drops out of its
    capabilities.
  - A refused plan or commit leaves the accepted observation to plan again.
  - After a definite refusal of a run or an upload, the extension keeps the frozen
    bytes only for `sync-paused`, `sync-disabled`, `too-many-open-runs`,
    `run-rate-limited` and `rate-limited`. Holdr lifts these without closing the run.
  - After any other refusal, Holdr has closed the run, so the bytes go. That includes
    a 401: a revoked device's open runs expire without an abort reason.
  - Receipts and aborts are never refused for authority.
  - A device credential that lapses after its 30 days gets 401 like a revoked one,
    but its unprocessed sets stay open for the owner's review. Only revoking it, a
    password reset or a binding change suspends them. A device would
    see a suspended set as `needs-review`.
- **Coverage.** Holdr refuses a scope outside the binding (`scope-not-in-binding`). It
  does not refuse a payload whose coverage leaves out a confirmed scope. The extension
  still covers every confirmed card of the account.
- **Payload size.** A binding may list 39 card hints (M4), but E1a still caps one
  payload at 20. Until that changes, the v2 builder refuses a preview for an account
  with more than 20 hints, naming the limit.

The client is `createHoldrClient` in `worker/holdrClient.ts`; nothing else in the
extension knows the routes. `apps/api`'s `device.compatibility.test.ts` (macOS) runs
this client and its schemas against E2c's handlers.