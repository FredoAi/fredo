# setup — Functional

> Fredo Setup auto-open removal + launcher tile (Issue #3010). The desktop no longer auto-opens
> the Setup wizard on startup; Fredo Setup is reachable only through explicit user action (the
> new launcher tile, and the existing Settings entry). Maps 1:1 to `.opencode/tmp/3010/triage.md`
> `## QA Expert` F-1..F-8.
>
> **Verification policy: live.** Every PASS carries `telemetry_spans` evidence from the env's own
> PostgreSQL cluster (manifest `ports.pg`); a static-only PASS is a FALSE PASS.
>
> **Binding hook (G-340):** `#fredo-launcher-grid [role="button"][aria-label="Fredo Setup"]` —
> display/accessible name `Fredo Setup`; NO new `data-testid`.
>
> Env: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3010 -EnvId spec3010 -EnvSlot <n>`.
> Plugin-not-installed profile lever (G-301): `-Action Clean -EnvId spec3010` then `Up` (the
> settings store is wiped, so `plugin_installed` is unset — the falsy condition the removed
> effect keyed on). Restart via explicit `Down` then `Up` carrying the same EnvId+EnvSlot (G-328).

## F-1 (R-1 / AC1) — No forced Setup on a fresh boot

- [ ] F-1: Fresh-slate env (settings key `plugin_installed` unset). Boot the desktop. Snapshot the
      DOM immediately, at +1.4 s, and at +5 s (past the deleted 1200 ms timer).
  **Expected:** at EVERY sample, NO `div[role="group"][aria-label="Fredo Setup"]`, NO
      `.fredo-window__surface` titled `Fredo Setup`, and NO `SetupWizard` in the DOM; the
      desktop/launcher renders (`#fredo-launcher-grid` reachable). `telemetry_spans` non-zero with
      a recent timestamp for the env.
  - **Edge:** a real plugin-absent profile (`Test-Path ~\.config\opencode\plugins\fredo.js` false)
    behaves identically (the reader is deleted, so plugin presence is irrelevant — R-5);
    `Ctrl+R` reload re-holds; empty/fresh store boot. No error path.

## F-2 (R-2 / AC2, binding hook) — Exactly one accessible-name launcher tile

- [ ] F-2: Engage the grid (`input[role="searchbox"]` focus / Ctrl+Space). Run
      `document.querySelectorAll('#fredo-launcher-grid [role="button"][aria-label="Fredo Setup"]')`.
  **Expected:** `.length === 1`; the tile is inside `#fredo-launcher-grid[role="grid"]`; NO
      duplicate tile (dedupe by id); the tile is visible and not clipped (its
      `getBoundingClientRect` is fully inside the grid's rect). The G-273 render clauses (appears
      once, no clip, ordering) are owned by ST-2.
  - **Edge:** query filter `setup` matches it; arrow-key nav can reach it (selectable); light AND
    dark render it; stable across reload.

## F-3 (R-2 / AC2) — Activating the tile opens the wizard in a window

- [ ] F-3: Click the F-2 hook tile. Then re-invoke it.
  **Expected:** a Fredo application window opens — `div[role="group"][aria-label="Fredo Setup"]`
      with header title `Fredo Setup`, rendering `SetupWizard` (six `STEPS` cards). Default
      presentation is `same-window` (kernel window — Architect binding); re-invoke focuses/restores
      the SAME window (`.fredo-window__surface` count stays 1).
  - **Edge:** open while another feature window is already open (z-order/focus); keyboard Enter on
    the focused tile; close then re-open.

## F-4 (R-3 / AC3) — Settings → Fredo Setup opens the SAME wizard

- [ ] F-4: Open Settings; click nav id `plugin-setup` (label `Fredo Setup`).
  **Expected:** the `plugin-setup` nav item exists and its content renders `<SetupWizard/>` — the
      SAME component as F-3, same six `STEPS` cards/steps/visuals, rendered not clipped.
  - **Edge:** light + dark; nav starts on Companion then switches; wizard opens with a feature
    window already open.

## F-5 (R-4 / AC4) — No automatic/forced route (continuous negative, G-123)

- [ ] F-5: Booted env, NO explicit open: observe ≥3 s idle (past the removed timer), `Ctrl+R`,
      focus/blur cycles, and drive the paths that used to auto-open (konami/companion mount).
  **Expected:** Setup never opens without user action — no `Fredo Setup` window/surface from any
      timed, reload, or automatic path; the ONLY opens observed are F-3 (tile) and F-4 (Settings).
      `fredo open-app setup` is an explicit user-initiated route only (Architect Discussion),
      never automatic.
  - **Edge:** plugin-not-installed profile (as F-1); rapid reloads; 10 s idle. No error path.

## F-6 (R-5 / AC5) — `plugin_installed` zero readers; no first-run gate regressed

- [ ] F-6: (static, non-AC pin) `rg "plugin_installed" apps/ui/src`; inspect `Home.tsx` imports
      and effects. (live) Confirm desktop startup + Companion/setup readiness behave as before.
  **Expected:** (static) ZERO `plugin_installed` hits under `apps/ui/src`; `Home.tsx` carries no
      `setupFeature`/`settingsService` import and no auto-open effect (ST-1). (live) desktop startup
      and Companion readiness are unchanged.
  - **Edge:** key absent elsewhere in `apps/ui/src`; no replacement gate/flag introduced.

## F-7 (E2E, mandatory) — End-to-end through the running desktop app (PG-only boot)

- [ ] F-7: Boot the app against its Postgres-backed instance
      (`-Action Up -Spec 3010 -EnvId spec3010 -EnvSlot <n>`; no SQLite). (a) observe boot past
      ~1.2 s with the plugin-not-installed profile (fresh-slate settings reset); (b) activate the
      tile AND Settings→Fredo Setup; (c) open Mission Monitor and confirm live sessions render.
  **Expected:** (a) desktop/launcher shows and NO Setup window auto-opens at any sample (incl.
      +1.4 s / +5 s); (b) the tile opens the wizard window AND Settings→`plugin-setup` opens the
      same wizard; (c) Mission Monitor renders its live session surface (the boot path is not broken
      by the effect removal). Each leg carries `telemetry_spans` + screenshot + console-clean.
  - **Edge:** boot twice; sample multiple timestamps; Mission Monitor with zero sessions renders its
    empty state (no crash). No error path.

## F-8 (Non-functional) — Accessibility / theme / console

- [ ] F-8: Keyboard-navigate the grid to the tile and open it; toggle light/dark; read the console
      across boot + every open.
  **Expected:** tile reachable by grid keyboard nav AND query filter; accessible name exactly
      `Fredo Setup`; tile + wizard window render token-native in light AND dark (no hardcoded
      color, no clip); console clean (no `Error:`/`Uncaught`/`Maximum update depth exceeded`).
  - **Edge:** long label ellipsis; reduced-motion; repeated open/close churn.

---

## #3198 — OpenCode 2 gate, global plugin install, no persistent OTLP wiring

> Seeded at triage for Spec #3198 (`## QA Expert` R-1a..R-2d + the NFRs). Maps 1:1 to the
> QA Plan table in `.opencode/tmp/3198/triage.md`.
>
> **Verification policy: live**, split as the plan declares: F-9..F-13 and F-16 carry
> committed-text/source evidence (message copy rendered from `MIN_SUPPORTED_OPENCODE_MAJOR`;
> the "does not install" leg is a prove-a-negative over the shipped error branch); F-14/F-15
> and F-17 are live; F-17 is a **NAMED BLOCKER until #3197 ships the V2 bundle**.
>
> **Constants — never a literal.** Read `MIN_SUPPORTED_OPENCODE_MAJOR`,
> `OPENCODE_UPGRADE_COMMAND`, `PLUGIN_INSTALLED_GLOBAL_MSG` and `VERSION_PROBE_TIMEOUT_MS`
> from `apps/tauri/src-tauri/src/infrastructure/opencode_version.rs` at test time and assert
> the RENDERED value. **Never hard-code "2"**: a row whose expectation encodes the current
> value of the constant is a suite defect (it passes a gate that moved and fails one that did
> not).
>
> **Fixtures (in-repo, G-172):** `fixtures/shim-opencode-1x/opencode.cmd` (prints
> `OpenCode 1.15.5` for `--version`, fails anything else),
> `fixtures/shim-opencode-nonzero/opencode.cmd` (`--version` exits 1, silent),
> `fixtures/shim-opencode-junk/opencode.cmd` (`--version` prints `hello from a fake cli`),
> `fixtures/shim-opencode-slow/opencode.cmd` (`--version` sleeps ~7 s).
>
> **PATH lever (G-316).** `dev-env.ps1`'s env seam is `-EnvVar` = **repeatable
> `NAME=value` strings** (`dev-env.ps1:186-201`) — the hashtable form does NOT work under
> `powershell -File`. For the in-app legs use PATH **replacement**:
> `-EnvVar "PATH=C:\Code\fredo\.opencode\tests\setup\fixtures\shim-opencode-1x"` — the app's
> `where`-style probe still resolves (`System32` is on CreateProcess's default search) and the
> gate blocks before any `bun` build, so a PATH without `bun` is harmless **for R-1 rows only**.
> For the CLI legs (`fredo` itself must also resolve) use the ST-1 forwarder
> `powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode Cli -ShimDir <fixture dir>
> -Args "<args>"` (its work item is named in the plan); if it is absent at test time, record
> the CLI leg UNVERIFIED with that named blocker — never a substitution.

## AC1 — the version gate (V1 detected and named)

- [ ] **F-9 (R-1a / AC1 — in-app gate names the version; runnable pre-#3197).**
  `dev-env.ps1 -Action Up -Spec 3198 -EnvId spec3198 -EnvSlot <n>
  -EnvVar "PATH=C:\Code\fredo\.opencode\tests\setup\fixtures\shim-opencode-1x"`, open the
  Setup surface, then read the IPC result of `check_all_setup` and `get_setup_plan`
  (`tauri_webview_execute_js` → `__TAURI__.core.invoke('check_all_setup')`).
  **Expected:** `opencode.status == "error"` (NEVER `"ok"`, NEVER `"missing"`); `detail`
  contains the shim's `1.15.5`, contains the rendered `MIN_SUPPORTED_OPENCODE_MAJOR` digit,
  contains the literal `opencode upgrade` **and** the literal `fredo setup --check`, and
  contains **no** `--major` (the installed runtime has no such flag — ST-1 probe:
  `opencode upgrade --help`); `opencode_version` is present and
  contains `1.15.5`; `can_proceed == false`; the `plugin`/`plugin-install` step is
  `skipped` or `blocked` (never `needed`/`ok`); the Setup surface RENDERS that same `detail`
  text (DOM snapshot contains it) and shows no success state.
  - **Edge:** never assert the surrounding prose — assert the tokens above plus the `--major`
    absence (the template is ST-1's `OPENCODE_VERSION_UNSUPPORTED_MSG`, rendered from
    `OPENCODE_UPGRADE_COMMAND`, unit-pinned). A message naming `--major` is a FAIL even if it
    also names `opencode upgrade`. The `.cmd` fixture also proves the `cmd.exe /C` rule. Wizard
    leg and `get_setup_plan` leg must agree.

- [ ] **F-10 (R-1a / AC1 — CLI twin; runnable pre-#3197, needs the ST-1 forwarder).**
  `powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode Cli
  -ShimDir .opencode/tests/setup/fixtures/shim-opencode-1x -Args "--check"` then
  the same with `-Args "--install-plugin"`.
  **Expected:** `--check` prints JSON whose `opencode` object is
  `{"status":"error","detail":<the same rendered message>}` plus `opencode_version`/
  `opencode_min_major`; `--install-plugin` exits **1** printing the same message on stderr or
  stdout and **writes nothing** (F-13 re-checks the destination hash).
  - **Edge:** `EXITCODE=` is part of the receipt; a silent exit 0 is a FAIL.

- [ ] **F-11 (R-1b / AC1 — undetermined version; runnable pre-#3197).** Repeat F-9/F-10 for
  **each** of `fixtures/shim-opencode-nonzero` and `fixtures/shim-opencode-junk`.
  **Expected:** status `"error"` with a detail naming the probe's own failure and the literal
  `opencode --version`; **NOT** `"missing"`, **NOT** `"ok"`, no install; in the serialized
  JSON `!("opencode_version" in obj)` — the undetermined version is an **ABSENT KEY**
  (`Object.prototype.hasOwnProperty` or `obj.get("opencode_version").is_none()` on the Rust
  side), never `null`, never `""` (G-413).
  - **Edge:** the junk fixture exercises `parse_major() == None`; the nonzero fixture
    exercises a spawn failure. Both must be `error`, not `missing`.

- [ ] **F-12 (NFR-3 / probe budget; runnable pre-#3197).** Repeat F-10 with
  `-ShimDir .opencode/tests/setup/fixtures/shim-opencode-slow`, timing the invocation.
  **Expected:** setup returns in **≤ 6 s** wall clock with F-11's undetermined error (the
  probe is bounded by `VERSION_PROBE_TIMEOUT_MS` = 5 000 ms); a hang, a 30 s+ wait, or a
  success is a FAIL. The constant is read from the source, not assumed.
  - **Edge:** the probe must run ONCE per invocation (no retry storm): the fixture prints one
    line per call — no per-call log exists, so bound the assertion to the wall clock.

- [ ] **F-13 (R-1c / AC1 — the gate installs NOTHING; runnable pre-#3197).** Before F-9..
  F-12: `Get-FileHash ~\.config\opencode\plugins\fredo.js -Algorithm SHA256` (record
  `PATH_MISSING` if `Test-Path` is false) and note the file's `LastWriteTime`. After: repeat.
  **Expected:** identical hash AND `LastWriteTime`, or still absent; if
  `~\.config\opencode\plugins` did not exist before, it does not exist after (no
  create-dir). Static half: quote the shipped error branch in
  `apps/tauri/src-tauri/src/applications/setup/commands.rs` with file:line and show the
  version-error return precedes any `std::fs::copy`/copy-helper call in the same function —
  no control-flow path from that return reaches the copy (the negative is the ABSENCE of a
  call on that branch, quoted, not inferred).
  - **Edge:** plugin already installed (hash-unchanged case) AND plugin absent
    (no-create case) are two separate legs — both run.

## AC2 — V2 setup end to end (live; needs #3197)

- [ ] **F-14 (R-2a / AC2 — one-pass install of the real artifact; NAMED BLOCKER until
  #3197).** Preconditions, recorded: (a) `opencode --version` (granted) reports a major
  **≥** `MIN_SUPPORTED_OPENCODE_MAJOR` — paste the literal line; (b) build the artifact:
  `bun run build` in `apps/opencode-plugin` (script `package.json:9`), then
  `Test-Path apps/opencode-plugin/dist/index.js` **true** and record
  `Get-FileHash dist/index.js -Algorithm SHA256` + `LastWriteTime`; (c) the artifact is
  #3197's V2 bundle (the developer's verification comment records the confirmed artifact
  name in `FREDO_PLUGIN_ARTIFACT_REL`). Then run `fredo setup --install-plugin` once.
  **Expected:** exit 0; `Test-Path ~\.config\opencode\plugins\fredo.js` **true**;
  `Get-FileHash` of the INSTALLED file **equals** the dist hash (currency proof — never
  grep the `~` path, G-244); no second manual step.
  - **Edge:** if `opencode --version` < the minimum, or `dist/index.js` is missing/stale,
    record **UNVERIFIED** naming that precondition — never install a fixture in its place
    and never report a fabricated PASS (a missing artifact must fail loud per ST-2).

- [ ] **F-15 (R-2b / AC2 — one `[fredo]` success line naming path + global).** From F-14's
  CLI run and from the in-app `install_plugin` (wizard action).
  **Expected:** stdout contains **exactly one** line whose text is the rendered
  `PLUGIN_INSTALLED_GLOBAL_MSG` — naming the resolved `…\.config\opencode\plugins\fredo.js`
  and stating global — and `InstallResult.output` contains the same rendered text.
  - **Edge:** do NOT assert a global `[fredo]` line count: the CLI progress reporter prefixes
    its own lines with `[fredo] ` (`setup.rs:86-99`). Assert only the message-bearing line.

- [ ] **F-16 (R-2c / AC2 — no persistent env write; telemetry reports not-required).**
  Static: `rg -n "setx|SetEnvironmentVariable|fredo-otel-opencode"` over
  `applications/setup/commands.rs` and `infrastructure/cli/commands/setup.rs`.
  **Expected:** **zero writer hits** (quote every hit, if any, with its disposition; the
  three `OPENCODE_*` names may survive only as read-only detection constants). Live: in
  F-9's app, `check_all_setup`/`--check` reports the `otel` step `status == "ok"` whose
  detail names the plugin/global install (not-required wording), **never `"missing"`**; and
  the `plugin-install` plan command string contains only the copy (no `set`/`setx`/`export`).
  - **Edge:** a pre-existing User-level `OPENCODE_*` value must be left AS IS (F-19).

- [ ] **F-17 (R-2d / AC2 — a session is captured after install; NAMED BLOCKER until
  #3197).** After F-14: open Terminal, start a session (default path), send one bounded turn
  `write_pty_input{sessionId, data:"Reply with exactly: FREDO_QA_3198_OK\r"}` (wait through
  the starting overlay), record the app's `session_id`, then query the env store:
  `powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 -Manifest
  .opencode/tmp/envs/spec3198/manifest.json -Query "SELECT session_id, span_name, provider,
  transport, count(*) AS n FROM telemetry_spans GROUP BY 1,2,3,4"` and again filtered
  `WHERE session_id = '<id>'`.
  **Expected:** ≥1 row for that `session_id` (the plugin's own spans — not a CLI-emitted row;
  the CLI emit path writes no spans, G-256); the install was the only setup action between
  the boot and the session; no per-session env var was set by Fredo (F-89 in the terminal
  suite).
  - **Edge:** the dev harness injects the ambient `OPENCODE_OTLP_ENDPOINT`
    (`dev-env.ps1:743-745`) — DISCLOSE this in the receipt: the live leg proves
    install→capture, and "the user typed nothing" is proven by F-16's zero-writer pin + the
    plugin's own default endpoint, not by the absence of the harness variable.

## Non-functional

- [ ] **F-18 (idempotency).** Run `fredo setup --install-plugin` a second time on the
  configured machine; capture `Get-FileHash` + `LastWriteTime` before and after.
  **Expected:** the destination hash is byte-identical (an in-place rewrite is allowed, a
  content change is not); F-15's single line prints again; no new PATH entry and no second
  rc block (the writer is deleted, F-16).
  - **Edge:** a third run; both entry points in sequence (in-app after CLI).

- [ ] **F-19 (no collateral writes).** From F-14's before/after records.
  **Expected:** the only filesystem writes the setup surfaces perform are the global plugins
  directory (create-dir) and the one `fredo.js` copy; pre-existing User-level `OPENCODE_*`
  values are unchanged (recorded before/after; a value that is deleted or rewritten is a
  PO-constraint FAIL — "a user who still has them set must not be worse off"); no `.bashrc`/
  `.zshrc`/PowerShell-profile append.
  - **Edge:** a machine with none of the three vars set; a machine with all three set.

## AC5 — documented (static: assert the committed text)

- [ ] **F-20 (R-5a / AC5 — supported runtime + default path + opt-out; runnable pre-#3197).**
  Read `docs/SETUP.md` (`## OTLP Configuration` / the reworked `### OpenCode`, and
  `## Environment Variables`) and `docs/CLI_GUIDE.md` (`## Setup (via UI)` table,
  `### fredo open-terminal`).
  **Expected — THREE claims present, quoted verbatim into the receipt:** (1) OpenCode **2**
  is the supported runtime (the minimum the gate enforces, stated as a major); (2) the default
  path installs the plugin into the **global** plugins directory and capture then works with
  **no exported variables**; (3) the **opt-out** — isolation (`FREDO_REQUIRE_ENV_ISOLATION`
  or a non-default OTLP endpoint) is the only case that still pins an endpoint / `--standalone`.
  Every claim must agree with the shipped constants and the shipped statuses (ST-2/ST-3).
  - **Edge:** a claim that names a different minimum major than
    `MIN_SUPPORTED_OPENCODE_MAJOR` is a FAIL (copy/constant drift); a claim that survives only in
    `research/**` is a FAIL (the user reads `docs/SETUP.md` and `docs/CLI_GUIDE.md`).

- [ ] **F-21 (R-5b / AC5 — CHANGELOG; runnable pre-#3197).** Read `CHANGELOG.md` →
  `## [Unreleased]` → `### Changed`.
  **Expected:** exactly one bullet stating the same three facts (OpenCode 2 supported; the new
  default path = global plugin install + no `OPENCODE_ENABLE_TELEMETRY`/`OPENCODE_OTLP_ENDPOINT`/
  `OPENCODE_OTLP_PROTOCOL` writes; the opt-out = isolation-only `--standalone`) and linking
  issue #3198.
  - **Edge:** the bullet must not present `--standalone` as the default (F-22); the shipped
    bullet style (bold lead sentence + indented sub-lines + issue link) is followed.

- [ ] **F-22 (R-5c / AC5 — the stale claims are GONE; runnable pre-#3197).**
  `rg -n -i "works with opencode|install the plugin in (each|every) project|per[- ]project"`
  over `docs/SETUP.md docs/CLI_GUIDE.md docs/FAQ.md docs/ARCHITECTURE.md CHANGELOG.md`, and
  `rg -n "standalone"` over the same set.
  **Expected:** the first search returns **zero** matches; every `standalone` hit states it is
  the isolation-only path, never "the default" and never "always".
  - **Edge:** a mention of the retired variables that says they are no longer required is a
    PASS; a "requires the latest OpenCode" style claim is a FAIL (the gate enforces a major,
    not perpetual tracking).
