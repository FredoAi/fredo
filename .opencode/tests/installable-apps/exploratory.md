# installable-apps — Exploratory Tests

Unscripted probes for the installed-application boundary. A confirmed finding **promotes** to
`functional.md` as a new `F-` row (keep the origin note). Probes are cheap live checks in the
isolated DEV env; only E-5 and E-8 need a generated fixture (extend the generator that owns that
fixture — see the note below — do not hand-roll a bespoke one for a single probe).

> **Which generator (#3146).** `.opencode/tests/installable-apps/fixtures/` now holds THREE committed
> generators, each owning one fixture family, and none may absorb another's:
> `build-package-fixtures.mjs` (install-refusal packages), `build-behaviour-fixtures.mjs` (runtime
> behaviour: probe / lazy-trace / crash / hang / fail-once) and
> `build-capability-fixtures.mjs` (capability declarations: `data.tables`, the two collision pairs,
> the consent pair, the no-declaration package and the two manifest-refusal packages). Extend the
> generator that already owns the family you need. **Why the third one exists rather than an
> extension of the second:** `build-behaviour-fixtures.mjs` ships a COMMITTED sha256 manifest and its
> `--verify` mode fails when a built fixture is missing from it, so adding archives there reddens a
> committed gate until someone re-runs `--write-expected` — and the QA Expert who authored these holds
> no shell (G-460), so it will not ship hashes it cannot derive. `build-capability-fixtures.mjs`
> therefore commits no hash manifest and proves determinism by a twice-run sha256 comparison instead.

> Do not probe the host's own privileged surfaces (MCP bridge commands, the settings KV) beyond what
> the spec's own rows already require. Do not probe the OS credential store or anything outside
> `.opencode/*` and the env's `FREDO_DATA_DIR`.

## Prompts (seed probes)

- [ ] **E-1 — a manifest that is valid JSON but hostile in shape.** Author a `fredo-app.json` by hand
  with `{"manifestVersion":1,"id":"qa3147-e1", ...}` where `entry.document` is `""`, `entry.module`
  is `"../x.js"`, and `id` is `"QA_Upper"`. Zip it (plain `Compress-Archive` under `.opencode/tmp/3147/`).
  - EXPECT: refused with the SPECIFIC field code (`entry_invalid` / `unsafe_path` / `id_invalid`),
    not a generic `manifest_invalid_field` collapse. Record which of the three fired first — that is
    the validation ORDER, and the ordering itself is worth reporting (it is unspecified in the plan).
  - WHY: the AC names the reason must be specific; a catch-all code would satisfy the letter of
    AC-3 and break the spirit.

- [ ] **E-2 — an id that collides with a built-in app id.** Manifest `id: "terminal"` (or
  `"wireframe"`), otherwise valid.
  - EXPECT: `id_reserved` (not `already_installed`, and never an install that then shadows the
    built-in). Verify `getApplications()` still returns the eight built-in ids afterwards.
  - WHY: `RESERVED_APP_IDS` is the mechanism; a miss here would let an installed app claim a built-in
    identity and would break AC-2's "built-ins behave exactly as they do today".

- [ ] **E-3 — an id that collides with an already-installed id but different content.** Install the
  valid package, edit its `version`, reinstall the same `id`.
  - EXPECT: `already_installed`. Then verify the installed copy is the ORIGINAL (version unchanged in
    the listing) — an upsert here would silently replace a working app.
  - WHY: the store is "directories ARE the registry"; the refusal path must be reached before any
    write, not after.

- [ ] **E-4 — a package that references a file it does not contain.** Valid manifest whose
  `entry.module` names `main.js`, but the zip ships only `index.html`.
  - EXPECT: `entry_missing` at install time (not a load-time failure), nothing installed.
  - WHY: an install-time refusal is strongly preferable to a deferred crash — if the product defers,
    record the actual behaviour and promote it (it changes which AC owns the failure).

- [ ] **E-5 — the probe app tries the OTHER doors.** Extend the ST-7 probe fixture (do NOT hand-roll
  a new generator — extend and re-run `build-behaviour-fixtures.mjs`) to also attempt, in order:
  `window.__TAURI__`, `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', …)`,
  `window.__TAURI_INTERNALS__.invoke('plugin:window|create', …)`.
  - EXPECT: `__TAURI__` is `undefined` (no global handle); the plugin calls are ACL-refused with an
    authority error; the page does not crash. Record each rejection message verbatim.
  - WHY: AC-2 says "Fredo's direct backend interface"; the sharpest probe is not one arbitrary
    command but the command families an app author would reach for first.

- [ ] **E-6 — the child opens a second document.** From inside the child, `window.open('fredoapp://localhost/<id>/index.html')`.
  - EXPECT: record what happens (likely blocked). Whether it is allowed or not is NOT specified by
    the plan — report the observed behaviour; if it opens a second window with the SAME origin, that
    is a containment finding worth promoting (a second browsing context at `fredoapp` shares the same
    absent capability, so it should be refused identically — confirm it is).
  - WHY: origin separation is per-origin, not per-window; a silently-permitted second context is
    still contained, but the reviewer should know it exists.

- [ ] **E-7 — close the window WHILE it is still loading.** Open the hang-on-load app, then close the
      window within ~1 s.
  - EXPECT: the window list shows no `installed-<id>`; no serve line for a later request (read the
      serve log exactly as `functional.md`'s **Serve-line receipt** specifies — grep
      `<env-root>/logs/dev-env-stdout.log` for `fredoapp`, current boot only; the
      `source="system"` read only if that source exists in this driver); no watchdog
      fires into a destroyed webview (check the host log for an error after the close). Re-open works.
      An absent serve line here is NOT a finding on its own — it is only admissible once the same log
      has shown a line for an earlier open in this boot.
  - WHY: the watchdog budget is 10 s; a timeout firing into a dead document is the classic
      race in this class of feature. A leaked timer with a log error is a finding; a crash is a FAIL
      of AC-4 containment.

- [ ] **E-8 — install a package whose `record.json` write is interrupted.** Use the hash-tamper
      fixture, then truncate `record.json` to 0 bytes and open.
  - EXPECT: `integrity_record_corrupt` for THAT app, and every OTHER installed app still opens
      (the corruption is per-app, the registry is per-directory).
  - WHY: AC-4's "a load failure is specific to that application" must survive a corrupted store.

- [ ] **E-9 — a very large but legal package.** Use the 4 096-entry cap: generate a package with
      exactly 4 096 entries (the generator's cap+1 case already proves the boundary; this probes the
      ACCEPT side live).
  - EXPECT: installs (or refuses with `archive_too_large` and the exact count in the detail). Quote
      the measured entry count and the elapsed install time — the accept side is not covered by the
      unit boundary test, only the reject side is.
  - WHY: a cap enforced by an off-by-one (`>` vs `>=`) is invisible to a reject-only test.

- [ ] **E-10 — theme changed while the app is CLOSED vs OPEN, in one sequence.** Open → read tokens →
      close → change accent → re-open → read tokens → change accent again while open (listen for
      `fredo-theme-change`) → read tokens.
  - EXPECT: the re-open carries the closed-state change; the while-open change lands without a reload
      (the mount stamp is unchanged). Both must be observed in ONE sequence — this is the only probe
      that distinguishes "served at open" from "pushed at change" in a single flow.
  - WHY: R-1.4 and R-1.5 are two moments of one transport; a sequence is stronger evidence than two
      isolated observations, and a single shared stale cache would pass the isolated pair.

- [ ] **E-11 — kill the child's webview process from outside.** Open the valid app, then kill the
      WebView2 renderer for that window (or close the window's OS handle directly).
  - EXPECT: the host survives; `tauri_manage_window list` reflects it; re-open works without a host
      restart. Record whether a `webview destroyed` error appears in the host log.
  - WHY: AC-4 containment and AC-5 re-open are tested via the app's own close; an out-of-band
      destruction is the hostile variant. If the tooling cannot target a single child renderer,
      record `UNVERIFIED — no per-window renderer kill lever` and do not substitute.

- [ ] **E-12 — two installed apps open at once.** Open both valid fixtures simultaneously.
  - EXPECT: two distinct windows, two distinct origins (both `fredoapp`), two distinct `data-app-id`
      values, neither app's theme read affected by the other's; a theme push reaches BOTH
      (each has its own `fredo-theme-change`).
  - WHY: the broadcast path enumerates `installed-*` windows; a single-window implementation would
      pass every other row. This is the multi-target gap G-397 warns about.

## #3146 probes (the declared-reach boundary)

> **Transport note (read before any probe that drives the child).** Every `tauri_webview_*` call
> against an `installed-*` window returns `Request timeout after 2000ms` (#3147), so a probe written
> as "from inside the child, call X" is **not producible** unless the fixture already drives it.
> The capability fixtures are **self-driving** (see `functional.md` → **Child evidence transport** and
> `README.md` §6): read their `[data-assertion]` lines with a native UIA read / native capture. A probe
> that needs a NEW child-side call is recorded `UNVERIFIED — no host-side child inject path (Toolsmith
> item, routed and non-gating)`; never drive it with an improvised one-off script and never call an
> `execute_js` timeout a result.

- [ ] **E-13 — a capability block that is well-typed but semantically hostile.** Take
  `build-capability-fixtures.mjs`'s `qa3146-app-a` and edit its `capabilities.data.tables[0].name` to a
  name that collides with ANOTHER declared table on the same app (`notes` twice), and separately to a
  name carrying a SQL metacharacter (`no\"tes`).
  - EXPECT: the first is refused with a named duplicate-table error from the shared declaration
    validator (quote it — the manifest must reuse `ApplicationDataDeclaration::validate`, not a second
    implementation, NFR-6); the second is refused by the charset gate. Record WHICH layer refused
    (manifest at install vs registry at materialize) — the plan does not fix the ordering and the
    ordering is worth reporting.
  - WHY: the plan reuses one validator; a second, weaker path in the manifest would be the bypass.

- [ ] **E-14 — a granted high-risk capability used where the action's own capability is undeclared.**
  With `qa3146-consent-b` (declares `high-risk.database-query` ONLY, no `data.tables`), grant
  `high-risk.database-query`, then drive
  `{action:\"application_data_read\", args:{ref:{source:\"application\",applicationId:\"qa3146-consent-b\",table:\"notes\"}}}`.
  - EXPECT: `action_not_declared` — a high-risk grant must never imply `data.tables`. Record the code
    and whether a `capability` field is present.
  - WHY: consent and declaration are two independent axes; a store that answers \"does this app have ANY
    grant\" rather than \"does it have THIS capability\" would pass F-7.18…F-7.20 and fail here.

- [ ] **E-15 — one installed document fetching another's bytes at the SAME origin.** Install
  `qa3146-app-a` and `mission`, open A, and from A's document
  `fetch('/cross-read-probe.html')` after also trying `fetch(location.href.replace('<A id>','<mission id>'))`.
  - EXPECT: record what happens. Every installed document is served at the same host origin, so whether
    one installed document can FETCH another's path is an origin-scope question the plan does not
    decide. A 200 carrying another app's HTML is a **finding worth promoting** (document-level
    cross-read); a 404/refusal is the expected answer.
  - WHY: #3146's boundary is *authority* (which actions, which data), NOT origin isolation — so this
    probe is deliberately OUTSIDE the ACs. Record and route the observation; do not FAIL any AC row on
    it, and do not row a sandbox claim.

- [ ] **E-16 — the consent store's tolerance for a malformed file.** With no app open, write
  `<FREDO_DATA_DIR>/installed-apps-consent.json` as
  `{\"version\":1,\"grants\":{\"qa3146-consent-a\":[\"high-risk.database-query\",\"nonsense\"]}}` and,
  in a second leg, as `{\"version\":999,\"grants\":{}}` — back the file up first and restore it after.
  - EXPECT: record the behaviour for each. The plan says a capability id not in that app's declaration
    is **ignored on read** — so leg 1 must not grant `nonsense` and must not crash; leg 2 (unknown
    version) is unspecified — record whether it is ignored or the store is reset, and whether the run
    continues. A crash or a wedge is a FAIL of the fail-safe NFR.
  - WHY: the store is host-owned JSON on disk; a malformed file must degrade to \"no grants\", never to
    \"grants everything\" and never to a panic. **Restore the file afterwards — F-7.22 and F-7.27 depend
    on it.**

## #3145 probes (the authoring kit)

> **Why these four.** The kit's whole risk is *drift*: a second description of a contract the parser
> owns. Each probe below asks one question the plan cannot answer by construction — **does the kit
> and the product disagree about the same bytes?** — and each names the in-repo lever, so none
> needs a bespoke artefact. A confirmed divergence **promotes** to `functional.md` as a new `F-8.x`
> row. **Transport note:** every probe here runs in a shell or on `main`'s `execute_js`; none drives
> the child, so the `installed-*` `tauri_webview_*` timeout is never in play.

- [ ] **E-17 — an optional manifest field that is `null` rather than absent.** Author two packages
  identical except one carries `"description": null` (and, in a second leg, `"capabilities": null`).
  Run `fredo-app check --json` on each, then install each through Settings.
  - EXPECT: `check` and the parser **agree** — the product treats both as absent
    (`manifest.rs:402-403` for `description`, `:621-626` for `capabilities`) and normalizes the key
    **out** of `<id>/manifest.json`; quote the normalized file. So the published schema must encode
    *absent*, and the kit must either accept `null` with the same normalizing advice or reject it
    with the same code the parser would — **not** a third middle position ("accepted here, refused
    there").
  - WHY: NFR-6 says the schema is generated from the parser and the corpus is its conformance
    corpus. A `null`-vs-absent rule is the one place a JSON-Schema copy almost always diverges, and
    the divergence is invisible until an author ships it.

- [ ] **E-18 — the exam's own REDDEN control.** Copy the kit as usual, then append one deliberately
  stale step to the **copied** document only (`pnpm --filter @fredo/ui build`), and re-dispatch the
  exam agent against that copy.
  - EXPECT: the exam **FAILS**, and it fails on **F1a** with `EXAM DOCUMENTED-PATH FAIL` naming the
    quoted stale step — because an agent that follows the document now reaches for the checkout.
    The **committed** document is restored immediately afterwards (never commit the mutation).
  - WHY: an exam that has only ever passed is an untested instrument. This is the one cheap way to
    show the harness discriminates, and it doubles as the proof that F1a is scored rather than
    narrated. **A run where the mutated doc still passes is a total FAIL of the exam instrument** —
    report it; do not soften the step to make it fail "more gently".

- [ ] **E-19 — an unknown capability-contract major, from both sides.** Author a package whose
  `capabilities` object is otherwise valid but carries `"version": 2`.
  - EXPECT: the product refuses **loudly** at install (a major it does not implement must never read
    as accepted — `read_capability_version`, `mod.rs:99-108`) with `manifest_invalid_field` and
    `field: "capabilities.version"`; quote the code and the detail. Then `fredo-app check --json`
    on the same dir: record whether it produces the **same** code+field or passes. Record.
  - WHY: this is the exact failure the additive rule exists to prevent, and it is the case a
    generated schema is most likely to leave out (a JSON Schema `const: 1` would catch it; a missing
    `enum` would not). Divergence here is a **finding to promote**, not a row failure.

- [ ] **E-20 — the reserved `__fredo/` segment, from the author's side.** Put a file at
  `work/my-app/__fredo/bootstrap.js` and run `fredo-app pack work/my-app --out …`.
  - EXPECT: `pack` **refuses** (it validates first — a package that would be refused is never
    emitted), naming the reserved path `__fredo`; exit non-zero; **no** zip is written at the output
    path. Then hand-zip the same directory and install it: the product refuses `reserved_path`.
    Quote both messages side by side.
  - WHY: the kit's `pack` is the author's last chance to catch it, and the two layers must agree on
    the **same** path token. A `pack` that silently *drops* the file (instead of refusing) produces
    a package the author believes contains their file — a worse outcome than a refusal, and worth
    promoting if observed.

_Confirmed probes promote to `functional.md`; a probe blocked by a sandbox/tooling limit is recorded
`UNVERIFIED` with a named blocker — never a PASS._

---

## #3144 probes (the lifecycle / management surface)

- [ ] **E-21.1 — a damaged `manifest.json` (the sibling of the `record.json` fixture).** Install A2
  (`qa3146-app-b`), then truncate `<FREDO_DATA_DIR>/installed-apps/qa3146-app-b/manifest.json` to 0
  bytes; open the pane.
  - EXPECT: A2 renders `Failing`, the other rows still list. **Routing note:** `list_installed_resilient`
  must cover BOTH readers (`store.rs:392` `read_record` **and** `:395` `read_manifest_file`) — an abort
  from the manifest side is a finding on the fixture's sibling, still a **host-observable** failure.
  - WHY: the plan's `F-9.1` names the `record.json` case; the manifest case is the same class and must
    not be a second aborting path.

- [ ] **E-21.2 — a corrupt / unknown-version lifecycle state file.** With A3 turned off, overwrite
  `<app_data_dir>/installed-apps-state.json` (a) with `{` (unparseable) and, in a second leg, (b) with
  `{\"version\":999,\"apps\":{}}` — back the file up and restore it after each leg.
  - EXPECT: the fail-closed read yields **"nothing disabled, nothing failed"** — the app reads
    `working`/`failing`, never a crash, never a wedge; it can only ever **REMOVE** a refusal and can
    never hide an application. Record the behaviour for each leg.
  - WHY: the state file is host-owned JSON on disk; a malformed file must degrade to "no lifecycle
    state", never to "everything refused" and never to a panic. **Restore the file afterwards — F-9.5/
    F-9.7 and R-10.8 depend on it.**

- [ ] **E-21.3 — a disabled app that is ALSO failing.** **Order is mandatory:** while A3 is enabled,
  damage its `record.json` under the registry and confirm its row reads `Failing`; **then** turn A3 off
  and re-read the pane.
  - EXPECT: the row reads **`Turned off`** (precedence `disabled > failing`), and A3 remains absent from
    the launcher. Record both `data-app-state` and the visible word.
  - **Second leg (the hostile ordering — expect NO new failure record):** with A3 already off, attempt an
    open. EXPECT: refused with `id_not_installed` and **no** new failure recorded (the disabled gate
    returns before `resolve_open_target`, so a disabled app accumulates no open outcome) — the row stays
    `Turned off`. Record the refusal code and the unchanged state.
  - WHY: `F-9.4` asserts the precedence; this probe also proves the disabled gate records nothing, which
    is the architect's binding open-path insertion.

- [ ] **E-21.4 — remove while the window is still open (the Windows file-lock question).** Install A4,
  open it (its own window), then click Remove and confirm.
  - EXPECT: the window closes **first**, then the registry directory is removed; the app is gone from
    the pane and the launcher; no error surfaces (or, if `remove_dir_all` cannot free the bytes, the
    app is still **absent** and debris remains under `installed-apps-removing/` — the architect's
    recorded recovery). Record whether any `io_error` surfaced and whether debris remains.
  - WHY: the architect lists "`WebviewWindow::close()` releases the install-directory handles" as an
    **UNVERIFIED** runtime claim; this probe is its cheapest hostile check. A removal that **fails**
    while the window is open is a finding worth promoting.

- [ ] **E-21.5 — remove, then re-install the same id.** Remove A4 (`qa3146-consent-a`), then install the
  same package again through Settings.
  - EXPECT: the install succeeds (the id is free again); the app's **kept** declared tables are still
    there (the disclosed keep-data outcome), so the re-installed app sees its old rows. Record the
    `application_data_read` before removal and after re-install.
  - WHY: the plan explicitly says removal KEEPS stored data and a re-install under the same id resumes
    the kept tables (consistent with `registry.rs`'s no-drop rule). This is the disclosed consequence
    made observable — record it; do not FAIL an AC on it.

- [ ] **E-21.6 — the copy-misdescription probe (the copy question).** Enumerate every
  user-reachable surface that can render a **reused** refusal code's sentence for a condition it
  misdescribes: (a) a **turned-off but installed** app, (b) a **damaged but installed** app.
  - Drive: turn A3 off; check every surface that offers or reports an open (the launcher — A3 is hidden,
    so nothing; the pane — no Open control; a host-driven `installed_app_open` — a refusal object the
    user never sees). Then damage A1's `record.json` and check the pane's
    `installed-apps-entry-failure` text.
  - EXPECT: **either** no user-reachable surface renders a misdescribing sentence (record which surfaces
    were checked and that each is empty/absent), **or** a surface does — then quote it verbatim and
    **promote the finding** (it is a copy defect, not a row failure). Specifically: the pane's failure
    line for a damaged-but-installed app must NOT read like "not installed" (Adjudication 10.4 resolved
    this with `failureReasons.ts`; `R-10.10` pins it).
  - WHY: the human's binding constraint (b). Reusing a frozen code is correct; bending a code's copy to
    cover a condition it was not written for is a lie of the same class as the `Full text` label and the
    "read-only" consent copy. Route the finding to UI/UX + PO; never encode a row that passes by
    asserting false copy.

- [ ] **E-21.7 — the empty inventory (0 installed apps).** Boot a clean env with zero installed apps and
  open the pane.
  - EXPECT: `[data-testid="installed-apps-empty"]` renders and `[data-testid="installed-apps-list"]` is
    absent; no panic; the launcher section renders its empty/absent state without throwing. Record which.
  - WHY: an empty inventory must be a first-class state, not a crash or a spinner (the `F-6.3` rule);
    it is also the pre-feature state `G-265` asks a trigger row to start from.

- [ ] **E-21.8 — a disabled app in the launcher vs in the pane.** Turn A3 off, then open the launcher
  (Ctrl+Space) and the pane in the same round.
  - EXPECT: A3 is **absent** from `[data-testid="launcher-installed-apps-section"]` (no open affordance),
    yet **present** in the pane as `Turned off`. Record both; if the launcher section is now empty it
    renders nothing (the section-absence rule).
  - WHY: the two surfaces have different contracts (ST-5 excludes only `disabled`; the pane is the
    inventory). A launcher that still offers a disabled app is a FAIL of `F-9.5`; a pane that omits it
    is a FAIL of AC-1.

---

## #3241 probes (the development marking's own failure surface)

> **Why these five.** AC 3's risk is not "the marker is missing" — that is a row. It is **"the marker
> is there and a user still cannot see it"**, and **"the marker exists and the build reaches
> further"**. Each probe asks one question the plan cannot answer by construction: *does the marking
> survive the state a user is actually in?* The dev leg is an **existing archive installed through
> `installed_app_install_development`** — no new fixture, no generator edit. A confirmed finding
> **promotes** to `functional.md` as a new `F-10.x` row with its origin note.

- [ ] **E-22.1 — the band over a full-bleed, scroll-driving app.** Install `qa3147-valid` in
  development mode, then in the child scroll its own content to the bottom (the fixture's probe plan
  renders enough lines to overflow; otherwise use `qa3146-no-capabilities` from
  `build-capability-fixtures.mjs`, whose mirror is long) and take a native capture at the top **and**
  after the scroll.
  - EXPECT: the band is visible at the **top edge of the window in BOTH captures** (a `position: fixed`
    band does not scroll away). The application's first ~28–32 px of its own content is overlaid — the
    disclosed cost; record whether it obscures anything the app needs.
  - WHY: `F-10.2` asserts perceivability at first paint; a band that scrolls out is the placement
    defect the plan's §C-6 corrects. A confirmed scroll-away promotes immediately.
  - **NOTE:** if the fixture's document does not overflow, say so and record `UNVERIFIED — fixture does
    not scroll` — do **not** author a bespoke scrolling fixture for this probe (G-460/G-172).

- [ ] **E-22.2 — the app deletes its own banner.** Install a development build, then — **only if a
  host-side child inject path exists in this round** (a Toolsmith item, **non-gating**) — remove the
  band's node from the child's own DOM and re-read S1 and S2.
  - EXPECT: **S1 (the OS title) still carries the marker** — the title is host-set and the child holds
    no `core:window:*` grant, so an application cannot unmark its own chrome. Quote the title and show
    the marker is the **leading** run (`Development — <displayName>`; `DEVELOPMENT_TITLE_PREFIX`), not
    merely present somewhere in the string. S2 goes unmarked (the app owns its DOM). Record both.
  - WHY: this is *why* S1 exists, and it is the one claim in the plan that is a **paired-carrier**
    argument rather than a single observation. **If no host-side inject path exists, record
    `UNVERIFIED — no host-side child inject path (Toolsmith item, routed and non-gating)`** — this is
    the pre-authorized limitation, and the plan's structural argument stands on the capability files
    (R-11.1), not on a probe that could not run. **Never drive it with an improvised one-off script.**

- [ ] **E-22.3 — the marker vs a lifecycle transition and a restart.** Install a development build;
  read all five surfaces; turn it **off**; re-read the pane (S3) and the launcher (S4); turn it back
  **on**; re-read; then **restart Fredo** on the same `FREDO_DATA_DIR` and re-read all five.
  - EXPECT: the mode survives every transition — `data-app-mode="development"` remains on the pane row
    even while `data-app-state="disabled"`, the launcher entry reappears marked when it is turned back
    on (painted chip `Development` **and** accessible name `<displayName>, development build` — C-1),
    and the title (leading prefix), band (leading token) and projection all still carry the marker after
    the restart.
  - WHY: `F-10.7` asserts the **released** control's durability across these transitions; this is the
    dev-side twin, and the disable/enable response replaces the whole entry in the frontend store — a
    mode-less response would silently unmark a row until the next listing.
  - **Record which states you could NOT reach** (the launcher hides a disabled app, so S4 is
    unreadable while off) rather than counting the absence as unmarked.

- [ ] **E-22.4 — a hand-deleted marker file (the residual the plan discloses).** Install a development
  build, then delete `<FREDO_DATA_DIR>/installed-apps/<id>/development.json` and re-list / re-open.
  - EXPECT: record the behaviour — after the delete and a fresh listing the app reads (and is marked
    as) **released**, because presence IS the fact. **This is a DISCLOSURE, not a defect**: the plan
    states that a user with write access to their own app-data directory can delete the marker, and
    that the product offers **no unmark path** (no command, no control, no setting). Restore the file
    afterwards.
  - WHY: the residual is stated in the plan's Discussion (the Architect's D-2) so the Auditor judges a
    decision instead of discovering an accident. **Do not FAIL any AC row on this** — a verdict that
    reports it as a defect is wrong in the other direction. Do **not** test the converse (a hand-
    CREATED marker on a normal install) as an unmark proof either — the same write access.
  - **Restore the file** — `F-10.7`'s dev control and `E-22.3` depend on it.

- [ ] **E-22.5 — the load control under a refusal, and a second dev install of an existing id.** On
  `main`, activate `[data-testid="installed-apps-install-development-button"]` with the **native picker
  dismissed** (or call the command with a non-existent path), then with an id that is **already
  installed**.
  - EXPECT: (a) the dismissal / bad path yields the **reused** frozen code `io_error` and the control
    is **re-enabled** afterwards (no permanently wedged control — the shipped "controls stay live after
    a refusal" rule); (b) an already-installed id yields `already_installed`, **no 23rd code**, and the
    existing install is untouched (the marker state of the existing install is unchanged: a released
    app stays released, a development app stays development).
  - WHY: `F-10.10`'s EDGE names the codes; this probe checks the **control's** behaviour and the
    **"does not silently upgrade/downgrade an existing install"** question, which is where a load path
    is most likely to mutate state.
  - **The native picker is not this probe's lever** if it cannot be driven automatically — call the
    command with an explicit bad path instead and record the substitution; never require a human to
    dismiss a dialog (G-414).
