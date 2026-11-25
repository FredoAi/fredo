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

_Confirmed probes promote to `functional.md`; a probe blocked by a sandbox/tooling limit is recorded
`UNVERIFIED` with a named blocker — never a PASS._
