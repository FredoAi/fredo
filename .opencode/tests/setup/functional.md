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

> Seeded at triage for Spec #3198 (`## QA Expert` R-1a..R-2e + the NFRs); **re-cut in round 3**
> (`## Fix Plan (round 3)`, plan item (d) / `ST-R3-3`) because the install-time service restart was
> **removed**. Maps 1:1 to the QA Plan table in `.opencode/tmp/3198/triage.md`.
>
> **The round-3 product shape these rows assert — and the deleted behaviour they must no longer
> name.**
> 1. **No install-time restart exists.** `install_plugin` (in-app) and
>    `fredo setup --install-plugin` (CLI) only **write** the plugin through
>    `install_plugin_file` (`infrastructure/opencode_service.rs`: SHA-256 hash-guarded write, plus
>    the install-instant `LastWriteTime` stamp on a real write). Deleted with the restart:
>    `--no-restart-service`, the `service status` probe, the restart dispatch, the
>    `restart_required` state, the restart-**`error`** outcome, and every `OPENCODE_SERVICE_*`
>    constant/message. A row that expects any of them asserts deleted behaviour — which is exactly
>    what round 2's F-17(b)/(c)/(d) and S-10 did.
> 2. **The `otel` step claims only the MECHANISM, never an install outcome.** status `ok`, detail =
>    the rendered `OTEL_CAPTURE_MECHANISM_MSG` (`applications/setup/commands.rs`), which states
>    that OpenCode loads the plugin **when its background service starts**. It must not say setup
>    restarts anything.
> 3. **Capture works because a server started AFTER the write loads the plugin** — and, per the
>    round-2 control (6 → 8 spans on a pre-write server), a pre-existing server can also pick it
>    up. F-17(a′) is therefore a **POSITIVE** control (≥1 span) under four receipts, not the old
>    `0`-row negative; the `0`-row expectation was the falsified half of the removed restart
>    rationale (G-462).
> 4. **The former G-461 blocker is gone with the restart.** An install against the real runtime no
>    longer performs a lifecycle action, so the real-service leg is **driven** (F-14 install,
>    F-17(a′)) instead of being recorded as unreachable — with the shared-service `pid` before/after
>    as the binding receipt that nothing was restarted.
>
> **Verification policy: live**, split as the plan declares: F-9..F-13, F-16 and F-20..F-22 carry
> committed-text/source evidence (message copy rendered from `MIN_SUPPORTED_OPENCODE_MAJOR`; the
> "does not install" leg is a prove-a-negative over the shipped error branch); F-14, F-15, F-17,
> F-18 and F-19 are live.
>
> **Meta-rule for every row below (G-462):** where a row's observable used to be reachable only
> through a destructive lever (install on the real runtime, restart the shared service), the row
> names the **non-destructive shape FIRST** — the write-only install, the store/receiver at the
> endpoint the protected process already emits to — and only then the fallback.
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
> **`shim-opencode-service-*` roster after round 3 — say which, do not leave it implied.**
> `fixtures/shim-opencode-service-ok/opencode.cmd` is **KEPT and USED** by F-17(b): it is now
> simply a fake OpenCode 2.x runtime (`--version` → `opencode v2.4.1`) reached through the
> product's own resolver, and the receipt is that its journal stays **EMPTY** — with the restart
> removed, no install may dispatch `service restart`. The other two are **UNUSED by every
> surviving row**: `fixtures/shim-opencode-service-fail` (its `service restart` exits 2) and
> `fixtures/shim-opencode-service-none` (its `service status` exits 1) existed only for the
> deleted restart-failure and no-service branches. **The commit that lands this re-cut deletes
> those two directories and their two `fixtures/README.md` roster rows** (the suite author cannot
> delete files). The **journal contract is unchanged** for the one fixture still in use: one line
> per `service restart`, appended to `%FREDO_QA_SHIM_JOURNAL%` (else
> `%TEMP%\fredo-3198-shim-journal.txt`); delete the journal before each leg.
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

- [ ] **F-14 (R-2a / AC2 — one-pass install of the real artifact; the write IS the whole action).**
  Preconditions, recorded: (a) `opencode --version` (granted) reports a major
  **≥** `MIN_SUPPORTED_OPENCODE_MAJOR` — paste the literal line; (b) the artifact:
  `Test-Path apps/opencode-plugin/dist/index.js` — if absent, build it in this row with
  `bun run build` in `apps/opencode-plugin` (script `package.json:9`); record
  `Get-FileHash dist/index.js -Algorithm SHA256` + `LastWriteTime`; (c) the artifact is #3197's V2
  bundle (the developer's verification comment records the confirmed artifact name in
  `FREDO_PLUGIN_ARTIFACT_REL`); (d) **the shared-service baseline, taken immediately before the
  install** — `SVC_URL = (opencode service status)`; `SVC_PORT = ([uri]$SVC_URL).Port`;
  `SVC_PID_BEFORE = (Get-NetTCPConnection -LocalPort $SVC_PORT -State Listen).OwningProcess` with
  `Get-Process -Id $SVC_PID_BEFORE | Select Id,ProcessName,StartTime`; (e) the destination's
  pre-state: `Test-Path ~\.config\opencode\plugins\fredo.js` plus its hash/`LastWriteTime`
  (`PATH_MISSING` if absent), so the row can restore it. **Force the real-write branch:** if the
  installed file already hashes equal to the artifact (a prior run left it current), delete it
  after recording the pre-state — otherwise this row exercises the no-write branch and its
  `LastWriteTime` assertion below would be unsatisfiable.

  Then run, from the repo root:
  `fredo setup --install-plugin` — **no flag**. There is no `--no-restart-service` any more and no
  restart to opt out of; the install is a file write only, so it is safe on a machine whose shared
  service hosts this pipeline. (Round 2's note that this row needed the opt-out "or a real write
  restarts this pipeline's own shared service" describes deleted behaviour.)

  **Safety receipt (binding, G-461):** re-read the owner of `SVC_PORT` after the run. The **same**
  `SVC_PID_BEFORE` on the same port is the receipt that nothing was restarted. A **changed** pid
  means the built product still performs the removed restart: **stop the row, record a FAILED DRIVE
  (`product still restarts the shared service`), do not re-run it.**

  **Expected:** exit 0; `Test-Path ~\.config\opencode\plugins\fredo.js` **true**;
  `Get-FileHash` of the INSTALLED file **equals** the dist hash (currency proof — never grep the
  `~` path, G-244); the installed file's `LastWriteTime` is **≥ the run's recorded start
  timestamp** — the install-instant stamp fired on a real write, so the destination mtime is
  neither the artifact's mtime nor the previous install's; stdout carries **exactly one**
  message-bearing line (F-15) and **zero** lines containing `service`, `restart` or
  `--no-restart-service`; no second manual step. Static half: `rg -n "OPENCODE_SERVICE_" apps/
  tauri/src-tauri/src` returns **zero** hits, and `rg -n "no_restart_service|no-restart-service"
  apps/tauri/src-tauri/src` returns **zero** hits.
  - **Edge:** if `opencode --version` < the minimum, or `dist/index.js` is missing/stale, record
    **UNVERIFIED** naming that precondition — never install a fixture in its place and never
    report a fabricated PASS (a missing artifact must fail loud, ST-2). Restore the destination's
    pre-state only **after** F-17 has used the installed file.

- [ ] **F-15 (R-2b / AC2 — one `[fredo]` success line naming path + global).** From F-14's
  CLI run and from the in-app `install_plugin` (wizard action).
  **Expected:** stdout contains **exactly one** line whose text is the rendered
  `PLUGIN_INSTALLED_GLOBAL_MSG` — naming the resolved `…\.config\opencode\plugins\fredo.js`
  and stating global — and `InstallResult.output` contains the same rendered text. **There is no
  second, outcome line at all:** the restart message family is deleted, so the output is one line
  in both faces (round 2 pinned "the restart/skip outcome line may follow"; that sentence is
  falsified and removed).
  - **Edge:** do NOT assert a global `[fredo]` line count: the CLI progress reporter prefixes
    its own lines with `[fredo] ` (`setup.rs:86-99`). Assert only the message-bearing line.

- [ ] **F-16 (R-2c + R-2e / AC2 — no persistent env write; the `otel` claim names the mechanism
  ONLY, never an install outcome).** Static: `rg -n "setx|SetEnvironmentVariable|fredo-otel-opencode"`
  over `applications/setup/commands.rs` and `infrastructure/cli/commands/setup.rs`.
  **Expected:** **zero writer hits** (quote every hit, if any, with its disposition; the
  three `OPENCODE_*` names may survive only as read-only detection constants). Live: in F-9's app,
  `check_all_setup`/`--check` reports the `otel` step with **status `"ok"`** — **NEVER `"missing"`,
  NEVER `"restart_required"`, and never a restart-failure `"error"`** (all three were removed with
  the restart; a surviving `error` after a successful install is a FAIL of this row), and:
  (i) the `detail` is the rendered `OTEL_CAPTURE_MECHANISM_MSG` — quote it verbatim and assert it
  **names the mechanism**: it contains `background service` and states the server **loads** the
  plugin when it starts; it must **not** contain `restart`/`restarted`/`service restart`, must not
  name `--no-restart-service`, and must not report an install outcome (nothing like "the service was
  restarted"/"could not be restarted") — **assert the constant, never paraphrase it** (read
  `OTEL_CAPTURE_MECHANISM_MSG` at test time and compare the rendered string, so a copy change is a
  FAIL rather than a silent pass);
  (ii) `check_otel_configured().opencode_configured == true` while the plugin file exists — with the
  restart record gone, file presence is the whole claim and there is no process-local failure state
  to contradict it (round 2's `false`-while-failed clause is deleted with the record);
  (iii) the `plugin-install` plan command string contains only the copy (no `set`/`setx`/`export`,
  no service verb).
  **`--check` is read-only:** it never touches the service — no probe, no restart, no lifecycle verb
  of any kind. Static receipt: `rg -n -i "service (restart|status)|OPENCODE_SERVICE_|restart_required"
  apps/tauri/src-tauri/src/applications/setup/commands.rs
  apps/tauri/src-tauri/src/infrastructure/cli/commands/setup.rs` → **zero hits**; the only `service`
  token that may survive in these two files is the shared write helper
  `opencode_service::install_plugin_file` (quote it and its call sites as the disposition).
  - **Edge:** a pre-existing User-level `OPENCODE_*` value must be left AS IS (F-19). A `--check`
    run and a `--install-plugin` run in **different processes** must report the same `otel` detail —
    the claim has no process-local state left to differ on (the round-2 fresh-process caveat is
    void).

- [ ] **F-17 (R-2d / AC2 — capture after install: the write-only install, a server started after it,
  and a pre-existing server that also picks it up).**
  **What this row no longer contains — said explicitly so nobody re-adds it.** Round 2's F-17(b1),
  (b3), (c) and (d) asserted the `service restart` dispatch, the `--no-restart-service` opt-out, the
  restart-failure `error`, and the no-service branch. **The install-time restart is removed from the
  product, so those receipts are DELETED, not rewritten**; (b) survives only as a **negative
  dispatch guard** (no lifecycle verb may be invoked), and round 2's "recorded-unreachable
  real-shared-service leg" is deleted because the real-service install is now a plain file write
  (driven by F-14). Two fixtures lose every consumer and are recorded UNUSED in the roster above
  (`shim-opencode-service-fail`, `shim-opencode-service-none`).
  **Safety rule for every REAL-runtime install in this suite:** there is no flag to pass — the
  install writes a file and dispatches nothing. The receipt that this held is the shared service's
  **pid + port owner before → after** (F-14(d)/(e)): a changed pid is a **FAILED DRIVE**
  (`product still restarts the shared service`), never a PASS.
  **(a) capture, live: a server started AFTER the plugin write captures.** Needs the REAL runtime
  (no shim) and F-14's install (plain `--install-plugin`). **Non-vacuity receipt first:**
  `(Get-Item -LiteralPath ~\.config\opencode\plugins\fredo.js).LastWriteTimeUtc` → `WRITE_UTC`
  (F-14's install instant); the server you start below must have
  `StartTime > WRITE_UTC` — record both, or the leg proves nothing. Then re-record
  `opencode serve --help` and `opencode --help` (round 2's receipts verify `serve` and
  `--server <url>`, but a runtime swap re-opens an unprobed tool-surface fact — G-460): continue only
  if both appear. Then, from a scratch script `.opencode/tmp/3198/capture-mech.ps1`: pick a port
  verified free
  (`(Test-NetConnection 127.0.0.1 -Port <p>).TcpTestSucceeded` is `False`), start
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
  this proves *install → server-started-after → captured*.
  **Fallback (disclose it):** if either flag is missing, copy
  `.opencode/tests/opencode-plugin/scripts/run-external-session.ps1` to `.opencode/tmp/3198/` and
  run it with the same marker (it hosts its own server via `--standalone`, so it is a
  server-started-after-the-install by construction).

  **(a′) a PRE-EXISTING server picks the plugin up — the under-controlled negative, re-cut to its
  true direction.** Round 2's own control produced **6 → 8** spans on a server that started
  **before** the write; that falsified the "invisible until a restart" premise, removed the restart,
  and made the old `0`-row expectation an assertion of deleted behaviour. **EXPECTED is now ≥1
  span, and 0 rows is a FAIL of this row** (G-462: the removed rationale failed by being
  *unnecessary*, so a `0` here would be re-asserting the falsified premise, not a negative control).
  Four receipts, taken in this order and recorded verbatim — a receipt that does not hold is a FAIL:
  1. **RECEIPT 1 — `PLUGIN_EXISTS=False` recorded immediately before that server starts.**
     `Remove-Item -LiteralPath ~\.config\opencode\plugins\fredo.js` then immediately
     `Test-Path -LiteralPath ~\.config\opencode\plugins\fredo.js` → `False`, stamped with
     `Get-Date -Format o`. Record the pair (`PLUGIN_EXISTS=False`, `ABSENT_AT`).
  2. **RECEIPT 2 — the server's `pid` + `StartTime`, and the port owner at the endpoint.**
     In the same pass as receipt 1 (nothing may install in between): pick a port verified free
     (`(Test-NetConnection 127.0.0.1 -Port <q>).TcpTestSucceeded` → `False`), start
     `opencode serve --port <q>` in the background, wait until it accepts a connection, then
     `SERVER_PID_BEFORE = (Get-NetTCPConnection -LocalPort <q> -State Listen | Select-Object -First 1)
     .OwningProcess`; `Get-Process -Id $SERVER_PID_BEFORE | Select-Object Id,ProcessName,StartTime`
     → `SERVER_START`. **The port owner must be that same pid** — record both, not one.
  3. **RECEIPT 3 — the plugin write's `LastWriteTime` strictly later than the server start.**
     `fredo setup --install-plugin` (no flag), then
     `(Get-Item -LiteralPath ~\.config\opencode\plugins\fredo.js).LastWriteTimeUtc` → `WRITE_UTC`,
     and assert `WRITE_UTC -gt SERVER_START.ToUniversalTime()` — **strictly** later. If the two
     compare equal at the recorded precision, re-run the leg with a ≥2 s gap between the server
     start and the install; never round them into a pass.
  4. **RECEIPT 4 — the SAME pid after the session (the server was not restarted).** Run one session
     on **that same pre-write server**:
     `opencode --server http://127.0.0.1:<q> run "Reply with exactly: FREDO_QA_3198_R2D_PRE"`, then
     re-read `(Get-NetTCPConnection -LocalPort <q> -State Listen | Select-Object -First 1)
     .OwningProcess` → `SERVER_PID_AFTER` and `Get-Process -Id $SERVER_PID_AFTER | Select-Object
     StartTime` → unchanged. **`SERVER_PID_AFTER -eq SERVER_PID_BEFORE` AND the `StartTime` is
     identical** is the receipt; a different pid or a new `StartTime` is a restart, which voids the
     control instead of proving it.
     **`opencode --server … session list` is UNVERIFIED** (G-460 — no planning role can execute it,
     and round 2 recorded only the `--server … run` form): the "not restarted" verdict must **not**
     rest on a `session list` read. The **pid/`StartTime` before-after control is the binding
     fallback** and decides receipt 4 on its own.
  5. Resolve the marker and count:
     `SELECT session_id, attributes_json::jsonb ->> 'prompt' FROM telemetry_spans WHERE
     span_name='fredo.session' ORDER BY start_time_ns DESC LIMIT 5`, then
     `SELECT count(*) FROM telemetry_spans WHERE session_id='<sid>'` through
     `telemetry-query.ps1 -Manifest .opencode/tmp/envs/spec3198/manifest.json`.
  **EXPECTED:** exactly one session carries `FREDO_QA_3198_R2D_PRE` and it holds **≥1**
  `telemetry_spans` row, with `PLUGIN_EXISTS=False` before `SERVER_START`, `WRITE_UTC >
  SERVER_START`, and the **same pid/port owner before and after** the session. The leg leaves
  `fredo.js` present (F-14 installed it; keep it).
  **Why this is the row that matters:** it is the only receipt that the **no-restart default**
  still captures on a machine that already had a server running — the mechanism AC2 leans on once
  the restart is gone.

  **(b) no service lifecycle verb is dispatched (the guard against re-adding the restart).** Use the
  **KEPT** fake control CLI `fixtures/shim-opencode-service-ok` — `--version` → `opencode v2.4.1`,
  and it appends its argv to the journal on any `service restart` — reached through
  `.opencode/scripts/setup-version-shim.ps1` so the **product's own resolver** picks it. Drive gate:
  the payload's `binary_path` resolves inside that fixture directory and the detected token is
  `2.4.1` (the fixture must PASS the version gate so the install path runs).
  Prepare: create the plugins dir; seed the destination with **different bytes**
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
  **EXPECTED (b1 — a real write dispatches NOTHING):** `Get-Content` the journal → **the file does
  not exist, or is empty: zero lines**. The install succeeds (CLI exit 0 / `InstallResult.success
  == true`), its output is exactly the one `PLUGIN_INSTALLED_GLOBAL_MSG` line (F-15) with **no**
  second line and **no** `service`/`restart` substring, and the destination hash equals
  `apps/opencode-plugin/dist/index.js`.
  **EXPECTED (b2 — a no-write re-run dispatches nothing either):** run the same install again with
  no artificial change → journal still **zero** lines, the success line prints again, and the
  destination's `Get-FileHash` **and `LastWriteTime` are unchanged** (the hash guard wrote nothing,
  so the install-instant stamp did not fire — F-18 pins the file side in full).
  **A journal line, a second output line, or a changed `LastWriteTime` is a FAIL:** it means the
  removed restart (or a stamp-on-no-op sibling) came back.

  - **LEVER / dependencies:** the fake CLI is reachable only with the forwarder's **L-1 shadow fix**
    (Toolsmith/Machinist-owned): if `where opencode.exe` names a path while the payload's
    `binary_path` sits outside the fixture dir, the shadow did not engage — record a **FAILED
    DRIVE**, never a product FAIL. Ordering: F-13's before/after hash record must be taken **before**
    this row (it rewrites the destination); F-14/F-15/F-18/F-19 use the real runtime with no flag.
  - **Edge:** the journal IS the receipt — a fixture that never fires shows zero lines and a stale
    journal shows lines from a previous leg; delete it in each leg or the count is invalid. Every
    message assertion renders from the shipped constant (`PLUGIN_INSTALLED_GLOBAL_MSG`) — never a
    hand-written line. A 0-row result in (a)/(a′) must first be **attributed** (did the server start?
    is that pid the port owner? did the plugin host get its endpoint? is the store the queried one?)
    and the cause named in the verdict — but attribution never softens it: **a 0-row (a′) is a
    FAIL**.

## Non-functional

- [ ] **F-18 (idempotency; the hash-guard's no-write clause — mtime included).** Run
  `fredo setup --install-plugin` (no flag — there is no opt-out left) a **second** time on the
  configured machine; capture `Get-FileHash` **and** `LastWriteTimeUtc` before and after.
  **Expected:** the destination hash is byte-identical **and `LastWriteTimeUtc` is byte-for-byte the
  same value** — an unchanged install writes no bytes, so `install_plugin_file` takes neither the
  copy nor the install-instant `set_modified` (a rewritten file that ends up content-equal but
  re-stamped is a **FAIL**: the guard is supposed to skip the write, and the stamp is what a later
  provenance read would trust); F-15's single line prints again; no new PATH entry and no second rc
  block (the writer is absent, F-16); and **no second output line at all** — the restart-outcome
  message family is deleted, so a re-run prints exactly what the first run printed. The dispatch
  half of the same clause (journal zero on a re-run) is F-17(b2); this row pins the file side.
  - **Edge:** a third run; both entry points in sequence (in-app after CLI) — a run that changes the
    bytes (re-built artifact) legitimately updates hash **and** `LastWriteTime`; that is the
    real-write branch, not a failure of this row.

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
  issue #3198. **And no restart claim:** the bullet must not state that setup restarts the
  background service, must not name `--no-restart-service`, and must not say a freshly installed
  bundle was "invisible until a restart" — the round that wrote that sentence disproved it
  (round-2 control: 6 → 8 spans on a pre-write server), so its survival is a FAIL of this row.
  - **Edge:** the bullet must not present `--standalone` as the default (F-22); the shipped
    bullet style (bold lead sentence + indented sub-lines + issue link) is followed.

- [ ] **F-22 (R-5c / AC5 — the stale and now-falsified claims are GONE; runnable pre-#3197).**
  Three searches over `docs/SETUP.md docs/CLI_GUIDE.md docs/FAQ.md docs/ARCHITECTURE.md
  CHANGELOG.md`:
  1. `rg -n -i "works with opencode|install the plugin in (each|every) project|per[- ]project"`
  2. `rg -n -- "--no-restart-service|no_restart_service|invisible until (a )?restart|until a restart"`
  3. `rg -n -i "restart(s)? the (opencode )?(background )?service|service restart"`
  and `rg -n "standalone"` over the same set.
  **Expected:** searches **1** and **2** return **zero** matches — the flag and the "invisible until a
  restart" sentence are gone from the product and from the docs the round disproved. **Search 3:**
  every hit must be a *negation* ("setup does not restart the service") quoted with its disposition;
  a **positive** claim, in any tense, is a FAIL. Every `standalone` hit states it is the
  isolation-only path, never "the default" and never "always".
  - **Edge:** a mention of the retired variables that says they are no longer required is a PASS;
    a "requires the latest OpenCode" style claim is a FAIL (the gate enforces a major, not
    perpetual tracking). If you conclude a negation should not be there at all, record it as a
    finding and quote the line — do not silently pass it.
