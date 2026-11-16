# installable-apps — Exploratory Tests

Unscripted probes for the installed-application boundary. A confirmed finding **promotes** to
`functional.md` as a new `F-` row (keep the origin note). Probes are cheap live checks in the
isolated DEV env; only E-5 and E-8 need a generated fixture (extend an existing one — do not author a
third generator).

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

_Confirmed probes promote to `functional.md`; a probe blocked by a sandbox/tooling limit is recorded
`UNVERIFIED` with a named blocker — never a PASS._
