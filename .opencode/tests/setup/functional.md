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

> Seeded at triage for Spec #3198 (`## QA Expert` R-1a..R-2e + the NFRs), re-cut in round 2 for the
> ST-S5 receipts (F-17) and the L-1 / L-2 fixture defects. Maps 1:1 to the QA Plan table in
> `.opencode/tmp/3198/triage.md` and the `## Fix Plan (round 2)` comment.
>
> **Verification policy: live**, split as the plan declares: F-9..F-13 and F-16 carry
> committed-text/source evidence (message copy rendered from `MIN_SUPPORTED_OPENCODE_MAJOR`;
> the "does not install" leg is a prove-a-negative over the shipped error branch); F-14/F-15
> and F-17 are live. F-17 is re-cut by fix-plan **addendum ST-A5** into (a) the capture-mechanism
> receipt, (b) the dispatch receipts (one restart / idempotent / opt-out), (c) the failure path,
> (d) the no-service path — plus ONE **recorded-unreachable** leg (installing against the real
> shared service, which hosts the pipeline's own session — G-461). Nothing in F-17 is a waivable
> blocker, and **`restart_required` is not a state the product emits**: the `otel` vocabulary is
> `ok` | `error` (R-2e, replaced in place by the addendum).
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
> `fixtures/shim-opencode-slow/opencode.cmd` (`--version` blocks ~7 s; its sleeping grandchild has
> **stdout AND stderr** redirected to `NUL` so it cannot hold the captured pipe — round-1 L-2; see
> `fixtures/README.md`). **No fixture is named `opencode.exe`, and none may be added:** a `.cmd`
> renamed to `.exe` is not a PE image, `CreateProcessW` refuses it, and the probe would report
> R-1b's *undetermined* state instead of R-1a's *unsupported* one — the wrong row passing for the
> wrong reason (round-2 Fix Plan, L-1).
>
> **PATH lever (G-316) — the committed forwarder owns the shadowing (round-2 Fix Plan, L-1).**
> `dev-env.ps1`'s env seam is `-EnvVar` = **repeatable `NAME=value` strings**
> (`dev-env.ps1:186-201`; it cannot compose a PATH, and the sandbox forbids command chaining), so
> the ONE lever is the committed forwarder
> `powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode <Up|Restart|Cli>
> -ShimDir <fixture dir> [...]`. It prepends the fixture directory **and drops every PATH entry
> that resolves an `opencode.*`** on the launched PATH (work item F4 — Toolsmith/Machinist-owned;
> QA never edits it). Two recipes that look plausible do NOT work and must not be used:
> (a) `-EnvVar "PATH=<fixture dir>"` — a PATH holding only the fixture cannot boot: `-Action Up`
>     runs `pnpm dev:tauri`, whose `beforeDevCommand` is
>     `pnpm --filter @fredo/fredo-opencode-plugin build` → `bun build`, so `pnpm`/`bun`/`node` must
>     stay reachable (and dropping the whole `.bun\bin` directory drops `bun`);
> (b) prepending a `.cmd` fixture while the installed binary is still on PATH — the product probes
>     `opencode.exe` before `opencode.cmd` and `where.exe` scans the WHOLE PATH per candidate
>     (`opencode_version.rs:314-333`), so an installed `opencode.exe` wins and the app probes the
>     REAL runtime. That is round-1's L-1 defect: AC1's in-app face was never driven. If the
>     forwarder's record shows it dropped nothing while `where opencode.exe` names a path, the lever
>     did not engage — record a **FAILED DRIVE**, never a product verdict.
>
> **Drive gate — the PRODUCT proves the fixture was the probed binary.** Read the resolved binary
> path out of the product's own payload: the check/plan step's `binary_path` (plan step `in_path`)
> must resolve **inside the fixture directory**, and the detected version token must be the
> fixture's (`1.15.5`; absent for the R-1b fixtures). A payload naming the host's installed runtime
> — `binary_path` outside the fixture dir, or the host's own version — means the app probed the
> real binary: a **FAILED DRIVE**, not a product FAIL. This is also the discriminating control:
> paste `where opencode.exe` (the host's installed path, if any); a payload reporting `1.15.5` on a
> host whose `where opencode.exe` names a path cannot have come from the installed runtime.

## AC1 — the version gate (V1 detected and named)

- [ ] **F-9 (R-1a / AC1 — in-app gate names the version; runnable pre-#3197).**
  Boot the 1.x fixture through the committed forwarder (header above):
  `powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode Up
  -ShimDir .opencode/tests/setup/fixtures/shim-opencode-1x -Spec 3198 -EnvId spec3198
  -EnvSlot <n> -RequireIsolation`
  **Record the lever state first:** paste `where opencode.exe` (the host's installed path, or
  `INFO: Could not find`), and the forwarder's own output. Then open the Setup surface and read the
  IPC result of `check_all_setup` and `get_setup_plan`
  (`tauri_webview_execute_js` → `__TAURI__.core.invoke('check_all_setup')`).
  **Expected:** (drive gate) the payload's `binary_path` / plan `in_path` resolves INSIDE
  `…\.opencode\tests\setup\fixtures\shim-opencode-1x` and the detected token is `1.15.5` — a
  `binary_path` outside the fixture dir (or the host's own version) is a **FAILED DRIVE**, no
  product verdict may be recorded; **and** `opencode.status == "error"` (NEVER `"ok"`, NEVER
  `"missing"`); `detail` contains the shim's `1.15.5`, contains the rendered
  `MIN_SUPPORTED_OPENCODE_MAJOR` digit, contains the literal `opencode upgrade` **and** the literal
  `fredo setup --check`, and contains **no** `--major` (the installed runtime has no such flag —
  ST-1 probe: `opencode upgrade --help`); `opencode_version` is present and contains `1.15.5`;
  `can_proceed == false`; the `plugin`/`plugin-install` step is `skipped` or `blocked` (never
  `needed`/`ok`); the Setup surface RENDERS that same `detail` text (DOM snapshot contains it) and
  shows no success state.
  - **LEVER (round-1 L-1 fix, round-2 form):** the shadowing is the forwarder's job (F4,
    Toolsmith/Machinist-owned): it prepends the fixture dir **and drops every PATH entry that
    resolves an `opencode.*`** on the launched PATH. QA adds no `.exe` fixture — a `.cmd` renamed
    `.exe` is not a PE image and `CreateProcessW` refuses it, which would land the probe on R-1b's
    *undetermined* row while this row (R-1a, *unsupported*) falsely passed. If `beforeDevCommand`
    fails for a missing `bun`, that is the lever dropping too much: record the forwarder's dropped
    list plus `where bun` and report a harness defect (never drop a whole toolchain directory to
    shadow one binary).
  - **Edge:** never assert the surrounding prose — assert the tokens above plus the `--major`
    absence (the template is ST-1's `OPENCODE_VERSION_UNSUPPORTED_MSG`, rendered from
    `OPENCODE_UPGRADE_COMMAND`, unit-pinned). A message naming `--major` is a FAIL even if it
    also names `opencode upgrade`. The `.cmd` fixture also proves the `cmd.exe /C` rule. Wizard
    leg and `get_setup_plan` leg must agree.

- [ ] **F-10 (R-1a / AC1 — CLI twin; runnable pre-#3197, needs the ST-1 forwarder).**
  `powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode Cli
  -ShimDir .opencode/tests/setup/fixtures/shim-opencode-1x -Args "--check"` then
  the same with `-Args "--install-plugin"`.
  **Expected:** (drive gate, see F-9) the payload's `binary_path` resolves inside
  `…\fixtures\shim-opencode-1x` — a `binary_path` outside it is a **FAILED DRIVE**, never a
  product FAIL — **and** `--check` prints JSON whose `opencode` object is
  `{"status":"error","detail":<the same rendered message>}` plus `opencode_version`/
  `opencode_min_major`; `--install-plugin` exits **1** printing the same message on stderr or
  stdout and **writes nothing** (F-13 re-checks the destination hash).
  - **Edge:** `EXITCODE=` is part of the receipt; a silent exit 0 is a FAIL.
  - **LEVER:** the shadowing is the forwarder's (F4); QA asserts only the product payload and the
    forwarder's own dropped-entries record. Do not hand-edit PATH.

- [ ] **F-11 (R-1b / AC1 — undetermined version; runnable pre-#3197).** Repeat F-9's in-app leg and
  F-10's CLI legs for **each** of `-ShimDir .opencode/tests/setup/fixtures/shim-opencode-nonzero`
  and `-ShimDir .opencode/tests/setup/fixtures/shim-opencode-junk` (same forwarder command shape;
  the drive gate applies per fixture — the payload's `binary_path` must resolve inside THAT
  fixture directory).
  **Expected:** status `"error"` with a detail naming the probe's own failure and the literal
  `opencode --version`; **NOT** `"missing"`, **NOT** `"ok"`, no install; in the serialized
  JSON `!("opencode_version" in obj)` — the undetermined version is an **ABSENT KEY**
  (`Object.prototype.hasOwnProperty` or `obj.get("opencode_version").is_none()` on the Rust
  side), never `null`, never `""` (G-413).
  - **Edge:** the junk fixture exercises `parse_major() == None`; the nonzero fixture
    exercises a spawn failure. Both must be `error`, not `missing`. **A fixture renamed to
    `opencode.exe` is forbidden here too:** a non-PE "executable" would make `CreateProcessW`
    fail and this row would pass on the *wrong* cause (round-2 Fix Plan, L-1).

- [ ] **F-12 (NFR-3 / probe budget; runnable pre-#3197).** First read `VERSION_PROBE_TIMEOUT_MS` from
  `apps/tauri/src-tauri/src/infrastructure/opencode_version.rs` at test time and record the literal
  (do not assume 5 000). Then run, timing it only as a hang detector
  (`$t = [Diagnostics.Stopwatch]::StartNew()` … `$t.Stop()`, or `Measure-Command`, keeping the
  output):
  `powershell -File .opencode/scripts/setup-version-shim.ps1 -Mode Cli
  -ShimDir .opencode/tests/setup/fixtures/shim-opencode-slow -Args "--check"`
  **Expected — the bound is the PRODUCT's own decision, not the harness's clock:**
  (a) **the outcome is R-1b's undetermined error, never a success and never `missing`**: the
  payload's `opencode.detail` contains the literal `did not finish within` **and** the rendered
  `VERSION_PROBE_TIMEOUT_MS` value — the probe's own timeout branch
  (`opencode_version.rs:53` for the constant, `:376-379` for the detail) — and `opencode_version`
  is an ABSENT key (F-11's rule); (b) the probe ran **ONCE** per invocation: one detail, one
  timeout window, no retry storm and no second 5 s segment; (c) **hang detector only — the
  invocation returns in ≤ 15 s**; a run that never returns, a 30 s+ wait, or a success is a FAIL.
  **Do NOT bound this row at 6 s and do not report a wall clock as the budget:** `powershell
  -File` + the forwarder + `fredo` startup sit outside the product's budget, so the only AC-grade
  reading is (a) — the product's own timeout detail — exactly as NFR-3 states it ("bounded at
  ≤ `VERSION_PROBE_TIMEOUT_MS` … a timeout is R-1b's undetermined error").
  - **LEVER / round-1 L-2 disclosure (fixture side, already applied):** the fixture's sleeping
    child is a `cmd.exe` **grandchild**, and `run_bounded` kills only the direct child
    (`opencode_version.rs:369-384`). Unredirected, `ping` inherits the invocation's captured stdout
    pipe (shell → `fredo` → `cmd.exe` → `ping`), so after the product's kill the shell waited on
    the survivor and the round-1 invocation measured **7 270 ms** while the bound had fired
    correctly. The fixture now redirects **both** streams (`ping -n 8 127.0.0.1 >nul 2>nul`), so
    the survivor holds no handle to the captured pipe. If a run still exceeds 15 s, record the
    surviving process (`Get-Process ping,cmd -ErrorAction SilentlyContinue`) as a `HARNESS-ARTEFACT`
    and judge (a)/(b) — the fixture's plumbing must never decide the AC.
  - **Edge:** assert the RENDERED constant inside the detail against the value read from source —
    a detail that says 5 000 ms while the constant says otherwise is a FAIL (copy/constant drift).
    The fixture prints one line per call and there is no per-call log, so bound the single-probe
    assertion to the single detail and the absence of a second timeout segment.

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

## AC2 — V2 setup end to end (live)

- [ ] **F-14 (R-2a / AC2 — one-pass install of the real artifact).** Preconditions, recorded:
  (a) `opencode --version` (granted) reports a major
  **≥** `MIN_SUPPORTED_OPENCODE_MAJOR` — paste the literal line; (b) the artifact:
  `Test-Path apps/opencode-plugin/dist/index.js` — if absent, build it in this row with
  `bun run build` in `apps/opencode-plugin` (script `package.json:9`); record
  `Get-FileHash dist/index.js -Algorithm SHA256` + `LastWriteTime`; (c) the artifact is
  #3197's V2 bundle (the developer's verification comment records the confirmed artifact
  name in `FREDO_PLUGIN_ARTIFACT_REL`). Then run
  `fredo setup --install-plugin --no-restart-service` once — **the opt-out is the safe form for a
  real-runtime install on this host**: without it, a real write restarts this pipeline's own shared
  service (G-461). The default (restarting) path is driven on the fake control CLI in F-17(b).
  **Expected:** exit 0; `Test-Path ~\.config\opencode\plugins\fredo.js` **true**;
  `Get-FileHash` of the INSTALLED file **equals** the dist hash (currency proof — never
  grep the `~` path, G-244); no second manual step; the skipped-restart outcome line
  (`OPENCODE_SERVICE_RESTART_SKIPPED_MSG`, F-17(b3)) is present and does not turn the run into a
  failure.
  - **Edge:** if `opencode --version` < the minimum, or `dist/index.js` is missing/stale,
    record **UNVERIFIED** naming that precondition — never install a fixture in its place
    and never report a fabricated PASS (a missing artifact must fail loud per ST-2).

- [ ] **F-15 (R-2b / AC2 — one `[fredo]` success line naming path + global).** From F-14's
  CLI run and from the in-app `install_plugin` (wizard action).
  **Expected:** stdout contains **exactly one** line whose text is the rendered
  `PLUGIN_INSTALLED_GLOBAL_MSG` — naming the resolved `…\.config\opencode\plugins\fredo.js`
  and stating global — and `InstallResult.output` contains the same rendered text. The
  restart/skip **outcome line is a different message** (F-17) and may follow on the next line; it is
  not a second success line.
  - **Edge:** do NOT assert a global `[fredo]` line count: the CLI progress reporter prefixes
    its own lines with `[fredo] ` (`setup.rs:86-99`). Assert only the message-bearing line.

- [ ] **F-16 (R-2c + R-2e / AC2 — no persistent env write; the `otel` claim is bounded, never
  false-green).** Static: `rg -n "setx|SetEnvironmentVariable|fredo-otel-opencode"` over
  `applications/setup/commands.rs` and `infrastructure/cli/commands/setup.rs`.
  **Expected:** **zero writer hits** (quote every hit, if any, with its disposition; the
  three `OPENCODE_*` names may survive only as read-only detection constants). Live: in F-9's app,
  `check_all_setup`/`--check` reports the `otel` step with a status in
  **{`"ok"`, `"error"`} — NEVER `"missing"` and NEVER `"restart_required"`** (that state no longer
  exists; the addendum replaced it with an install-time action), and:
  (i) the `ok` case's `detail` **states the mechanism** — it names that OpenCode loads the plugin
  when its background service starts **and** that setup restarts the service after installing —
  never a bare "configured" (quote it; render from the shipped constant, do not paraphrase);
  (ii) the `error` case appears **only** when this process knows a restart failed (install ran and
  failed — F-17(c) produces it in the same process) and its `detail` is the rendered failure
  message; (iii) `check_otel_configured().opencode_configured == false` while that failure is
  recorded (file presence alone must not read as configured) and `true` otherwise; (iv) the
  `plugin-install` plan command string contains only the copy (no `set`/`setx`/`export`).
  **`--check` is read-only:** it never restarts the service (only the bounded probe runs, and only
  when `version.is_supported() && plugin_installed`).
  - **Edge:** a pre-existing User-level `OPENCODE_*` value must be left AS IS (F-19). A `--check`
    run in a *fresh process* after a failed install cannot know the failure — that is expected
    (process-local record); assert (ii)/(iii) in the process that ran the install, via F-17(c).

- [ ] **F-17 (R-2d + R-2e / AC2 — capture after install, and the restart dispatch).**
  **R-2e (addendum, binding):** *WHEN setup installs the Fredo plugin on a supported OpenCode
  runtime, the installed bytes differ from what was already on disk, and an OpenCode background
  service is running, the system SHALL restart that service through the runtime's own
  `opencode service restart` verb and SHALL report the outcome; WHEN the restart does not complete
  successfully, the system SHALL report the install as failed with the remedy — never as `ok`,
  never as a silent success. WHILE the installed bytes are already current, or no background
  service is running, the system SHALL NOT restart the service. The system SHALL NOT terminate,
  signal or otherwise kill any process directly.*
  Four receipts (addendum ST-A5); a FAIL is a receipt that does not hold. **No receipt touches the
  real background service** — that leg is recorded at the end, not driven.
  **Safety rule for every REAL-runtime install in this suite:** pass `--no-restart-service` (the
  documented opt-out) so this pipeline's own shared service is never restarted; the restart itself
  is proven on the fake control CLI, where a restart is inert. The opt-out's own semantics are
  receipt (b3).
  **(a) R-2d — capture, live: a server started AFTER the install captures.** Needs the REAL
  runtime (no shim) and F-14's install. **Probe gate first — both flags are UNVERIFIED:** record
  `opencode serve --help` and `opencode --help`; continue only if `serve` and `--server <url>`
  appear. Then, from a scratch script `.opencode/tmp/3198/capture-mech.ps1`: pick a port verified
  free (`(Test-NetConnection 127.0.0.1 -Port <p>).TcpTestSucceeded` is `False`), start
  `opencode serve --port <p>` **in the background** (env-owned, disposable), wait until the port
  accepts a connection, then run the client
  `opencode --server http://127.0.0.1:<p> run "Reply with exactly: FREDO_QA_3198_R2D"`.
  Resolve the session by its marker — `SELECT session_id, attributes_json::jsonb ->> 'prompt' FROM
  telemetry_spans WHERE span_name='fredo.session' ORDER BY start_time_ns DESC LIMIT 5` via
  `powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 -Manifest
  .opencode/tmp/envs/spec3198/manifest.json` — then
  `SELECT count(*) FROM telemetry_spans WHERE session_id = '<sid>'`.
  **EXPECTED:** exactly one session carries `FREDO_QA_3198_R2D` and it has **≥1 `telemetry_spans`
  row** (the plugin's own spans — the CLI emit path writes no spans, G-256); the server was started
  **after** the plugin write and is torn down with the run.
  **DISCLOSE THE FORM:** an env-owned server of the same plugin-host type as the shared service —
  this proves *install → server-started-after → captured*, not a restart-in-place.
  **Fallback (disclose it):** if either flag is missing, copy
  `.opencode/tests/opencode-plugin/scripts/run-external-session.ps1` to `.opencode/tmp/3198/` and
  run it with the same marker (it hosts its own server via `--standalone`, so it is a
  server-started-after-the-install by construction).
  **(a′) R-2d — the negative control that makes (a) non-vacuous (E-1, reproduced).** Record the
  destination's pre-state (F-14), then `Remove-Item ~\.config\opencode\plugins\fredo.js`, start an
  env-owned server on another free port (so the plugin is **absent when it starts**), install
  (`--no-restart-service`) so the bytes land **after** that server started, then run one more
  session on **that same pre-write server** with marker `FREDO_QA_3198_R2D_PRE`.
  **EXPECTED:** **0** `telemetry_spans` rows for `FREDO_QA_3198_R2D_PRE` — a pre-write server does
  not load the plugin, which is exactly why the install must restart the service. If rows DO appear,
  the runtime hot-loads the plugin: record it as a finding (it does not fail (a), but it voids the
  addendum's inferred "restart is what makes capture work" link). The leg leaves `fredo.js` present
  (re-run F-14's install if needed).
  **(b) R-2e — dispatch, live: exactly one `service restart`, at the write, and reported.** Use the
  **fake control CLI** `fixtures/shim-opencode-service-ok` — it answers `--version` →
  `opencode v2.4.1`, `service status` → `http://127.0.0.1:28894` (exit 0), and appends its argv to
  the journal on `service restart` — reached through `.opencode/scripts/setup-version-shim.ps1` so
  the **product's own resolver** picks it. Drive gate: the payload's `binary_path` resolves inside
  that fixture directory.
  Prepare once: create the plugins dir; seed the destination with **different bytes**
  (`Set-Content -LiteralPath ~\.config\opencode\plugins\fredo.js -Value '// stale placeholder'`); and
  delete the journal `.opencode/tmp/3198/shim-journal.txt`. Journal wiring — CLI leg: a scratch
  wrapper `.opencode/tmp/3198/dispatch-cli.ps1` holding
  `$env:FREDO_QA_SHIM_JOURNAL = 'C:\Code\fredo\.opencode\tmp\3198\shim-journal.txt'`, then
  `& powershell -File 'C:\Code\fredo\.opencode\scripts\setup-version-shim.ps1' -Mode Cli -ShimDir
  'C:\Code\fredo\.opencode\tests\setup\fixtures\shim-opencode-service-ok' -Args '--install-plugin'`,
  then `exit $LASTEXITCODE`; app leg: boot with `-Mode Up … -ShimDir …\shim-opencode-service-ok
  -ExtraEnvVar "FREDO_QA_SHIM_JOURNAL=C:\Code\fredo\.opencode\tmp\3198\shim-journal.txt"` and run
  the wizard's install (or `invoke('install_plugin')`). **Both faces run this receipt** — never
  substitute the CLI for the app.
  **EXPECTED (b1, one restart):** `Get-Content` the journal → **exactly one** line `service
  restart`; the install succeeds (CLI exit 0 / `InstallResult.success == true`) and its output
  carries the rendered `OPENCODE_SERVICE_RESTARTED_MSG` **after** the `PLUGIN_INSTALLED_GLOBAL_MSG`
  line (record both verbatim, rendered from the constants).
  **EXPECTED (b2, idempotency — a no-write run restarts nothing):** run the same install again with
  no artificial change; the journal gains **zero** new lines, the success line prints again, and
  **no** restart-outcome line appears (the hash guard wrote nothing). Record both journal counts and
  the destination hash.
  **EXPECTED (b3, opt-out):** re-seed the destination with different bytes, delete the journal, run
  the CLI leg with `-Args "--install-plugin --no-restart-service"` → journal **zero** lines, CLI
  **exit 0**, install successful, output carries the rendered
  `OPENCODE_SERVICE_RESTART_SKIPPED_MSG` naming `opencode service restart` (rendered from
  `OPENCODE_SERVICE_RESTART_COMMAND`, never a hand-written command).
  **(c) R-2e — failure path, live: a failed restart fails the install and keeps the file.** With
  `fixtures/shim-opencode-service-fail` (its `service restart` prints one stderr line and exits
  **2**): re-seed the destination with different bytes, delete the journal, install through the
  forwarder (CLI leg as in (b), plus the app leg for the same-process half).
  **EXPECTED:** the journal shows **one** `service restart` attempt; `InstallResult.success ==
  false` with `error` = the rendered `OPENCODE_SERVICE_RESTART_FAILED_MSG`, whose `{detail}` is the
  child's own exit code **2** plus its stderr line (record verbatim) and whose `{restart}` renders
  `opencode service restart`; the **CLI exits 1** through `fail_step` (stderr carries the message);
  **`~\.config\opencode\plugins\fredo.js` is still on disk and hash-equal to
  `apps/opencode-plugin/dist/index.js`** (the copy succeeded — the failure is the capture outcome,
  not the file); and in the same app process `check_all_setup`'s `otel` step is `status == "error"`
  with that detail while `check_otel_configured().opencode_configured == false` (F-16 ii/iii).
  **Never `ok` on a failed restart.**
  **(d) R-2e — no-service path, live: nothing to restart, so no restart.** With
  `fixtures/shim-opencode-service-none` (its `service status` exits **1** — no Running service):
  re-seed the destination with different bytes, delete the journal, install (CLI leg).
  **EXPECTED:** journal **zero** lines (no restart on `Absent`/`Unknown` — never restart on a
  guess), `InstallResult.success == true`, CLI exit 0, no restart-outcome line, and the `otel` step
  `ok` — today's successful install, file byte-equal to the artifact.
  - **RECORD, do not waive — the one unreachable leg:** installing **against the real shared
    background service** and letting setup restart it is undrivable here: that service hosts this
    pipeline's own session, so the restart would end the run (**G-461**). Record the service's
    identity (`opencode service status` → its URL) and the exact command that would have run
    (`fredo setup --install-plugin`, no opt-out), then point at (b) + (c) + (d) as the closed chain:
    the dispatch, its idempotency, its opt-out, its failure and its no-service branch are all driven
    through the product's real code path on the fake control CLI; the residual — that the runtime's
    own `restart` verb reloads plugins — is the runtime's contract (proven for a fresh server in
    (a)). This is a recorded environment limit, never an UNVERIFIED verdict and never a FAIL.
  - **LEVER / dependencies:** the fake CLI is reachable only with the forwarder's **L-1 shadow fix**
    (addendum ST-A6, Toolsmith/Machinist-owned): if `where opencode.exe` names a path while the
    payload's `binary_path` sits outside the fixture dir, the shadow did not engage — record a
    **FAILED DRIVE**, never a product FAIL. Ordering: F-13's before/after hash record must be taken
    **before** this row (it rewrites the destination); F-14/F-15/F-18 use the real runtime with
    `--no-restart-service` so this pipeline's service is never touched.
  - **Edge:** the journal IS the receipt — a fixture that never fires shows zero lines and a double
    dispatch shows two; delete the journal in each leg or the count is invalid. Every message
    assertion renders from the shipped constants (`OPENCODE_SERVICE_RESTARTED_MSG`,
    `_FAILED_MSG`, `_SKIPPED_MSG`; `{restart}` from `OPENCODE_SERVICE_RESTART_COMMAND`) — never a
    hand-written command. A 0-row result in (a) must first be attributed to the lever (did the
    plugin host receive `OPENCODE_OTLP_ENDPOINT`? did the server start?) before it is called a
    product FAIL.

## Non-functional

- [ ] **F-18 (idempotency; R-2e's no-write ⇒ no-restart clause).** Run
  `fredo setup --install-plugin --no-restart-service` a second time on the configured machine;
  capture `Get-FileHash` + `LastWriteTime` before and after.
  **Expected:** the destination hash is byte-identical (an in-place rewrite is allowed, a
  content change is not); F-15's single line prints again; no new PATH entry and no second
  rc block (the writer is deleted, F-16); and **no restart outcome line** — an unchanged install
  writes no bytes, so nothing restarts. The restart-side of that clause (journal zero on a re-run)
  is F-17(b2); this row pins the file side.
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
