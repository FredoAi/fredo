# Hotkeys — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the hotkey
> surface (issue #2946). Runs on a RUNNING Fredo desktop app on the `spec/2946` build
> (dev-env UP, MCP driver `com.fredo.app`).
>
> **Verification policy: live** — every case's evidence carries a `telemetry_spans`
> live-run receipt for its drive window plus the DOM/screenshot assertion. A static-only
> PASS fails closed.

> **#3009 supersedes (OBSOLETE — do NOT re-run on `spec/3009`).** The configurable-hotkeys
> platform is REMOVED. The `#2958` quick paths (S-10..S-12), `#2959` quick paths
> (S-13..S-16), `#2960` quick paths (S-17..S-20), `#2961` quick paths (S-21..S-22), and
> `#2962` quick paths (S-23..S-25) are OBSOLETE. Their surviving invariants are restated in
> the Spec #3009 quick paths below (S-26..S-30). Do NOT delete the superseded rows.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Hotkeys surface reachable — open Settings (launcher tile `[role="button"][aria-label="Settings"]`), select the Hotkeys section, and confirm the single binding listing renders (both tiers or, with no feature focused, the global tier)
- [ ] S-4: Telemetry Settings accessible — the Settings window renders its sections (Companion, Appearance, Fredo Setup, Telemetry + discovered features) alongside Hotkeys
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2946/e2e/smoke.jpeg")` succeeds

## Hotkey quick paths

- [ ] S-6: **Ctrl+Space still opens the launcher.** From the resting desktop, press Ctrl+Space. **Expected:** the launcher bar appears with the caret in `input[role="searchbox"]`; screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-7: **A leader sequence shows pending hints.** Press the leader prefix on a non-text surface. **Expected:** a which-key overlay appears naming the pending prefix + valid next keys; pressing Escape resets it with no action; screenshot succeeds; console clean.
- [ ] S-8: **A text field suppresses bare shortcuts.** Focus a text-entry field (e.g. `[data-testid="launcher-command-input"]`) and type a bare key bound to a feature shortcut. **Expected:** the character lands verbatim in the field and NO action fires; screenshot succeeds; console clean.
- [ ] S-9: **CI-parity gate.** Run `pnpm --filter @fredo/ui build` (expect exit 0, zero TypeScript errors), `pnpm --filter @fredo/ui test:run` (expect green), and the repo lint/typecheck leg. **Expected:** all pass with no weakened/disabled assertion.

## Spec #2958 quick paths (named interaction contexts) — **#3009 supersedes (OBSOLETE)**

- [ ] S-10: **A root context exists at boot.** On the resting desktop read the active context via `getHotkeyContextSnapshot()` (or the `hotkeys-context-indicator` testid after a change). **Expected:** the platform root context is the default (`contextId 'fredo.root'`, label `'Fredo'`, `depth 1` — path length, base only); a context change renders the indicator text label (`hotkeys-context-indicator-label`, not colour-only); console clean. *(live receipt)*
- [ ] S-11: **Descend + Escape quick path.** Focus a feature with a deeper context, descend (keyboard only), observe the context change, then press Escape once. **Expected:** `hotkeys-context-indicator-label`/`-depth` change on descent and return to the previous value on one Escape; the indicator + announcer both update; console clean. *(live receipt)*
- [ ] S-12: **Context change is announced.** Sample `[data-testid="hotkeys-announcer"]` before and after a descent. **Expected:** the announcement text changes on the context change (polite live region, non-empty); screenshot succeeds. *(live receipt)*

## Spec #2959 quick paths (keyboard mode + persistent key bar) — **#3009 supersedes (OBSOLETE)**

- [ ] S-13: **Entry/exit chord round-trips.** On the resting desktop fire the mode entry chord, then the exit chord. **Expected:** the mode indication appears (non-colour-only label/icon) and the bar renders; on exit the bar hides and focus is where it was; console clean. *(live receipt)*
- [ ] S-14: **Bar persists with no pending sequence.** Enter mode and wait past the sequence timeout with `data-fredo-pending-sequence` null. **Expected:** the bar is STILL present listing the current context's actions + keys (not only a mid-sequence hint); screenshot succeeds. *(live receipt)*
- [ ] S-15: **Bar follows a context change.** With mode on, descend (`primary+K`) then Escape. **Expected:** the bar rows change to the deeper context's actions and back, with mode still on and no re-entry; console clean. *(live receipt)*
- [ ] S-16: **Entry is announced.** Sample `[data-testid="hotkeys-announcer"]` before and after entering mode, and after a context change. **Expected:** a non-empty announcement fires on entry and on the context change through the single polite live region; screenshot succeeds. *(live receipt)*

## Hotkeys smoke round 1 — result (FAIL — served app does not boot)

**Blocking finding (round 1):** the SERVED app (`apps/tauri` dev entry, port 5174)
never mounts. Vite fails at import-analysis on the spec branch tip `e823a07a`:

```
[plugin:vite:import-analysis] Failed to resolve import "@/shared/utils/colorTint"
from "../ui/src/shared/components/hotkeys/Keycap.tsx". Does the file exist?
```

Root cause: `Keycap.tsx` (new ST-3 file) uses the `@/` alias, but the SERVED
`apps/tauri/vite.config.ts` resolves `@` → `apps/tauri/src` (only `main.tsx` lives
there) — NOT `apps/ui/src` where the module actually is. `apps/ui/vite.config.ts`
does resolve `@` → `apps/ui/src`, which is why `pnpm --filter @fredo/ui build` and
`test:run` are green while the shipped webview is blank. Same class as G-251
(library green, served host broken).

Second blocking finding: the SERVED entry `apps/tauri/src/main.tsx` never imports or
mounts `HotkeysProvider` (only the standalone `apps/ui/src/main.tsx` does), so even
with the alias fixed the engine/announcer/which-key overlay would be absent from the
shipped webview.

- [ ] S-1: App window renders — **FAIL.** `document.getElementById('root')` has 0
      children; `tauri_webview_dom_snapshot` body = `div#root` + `vite-error-overlay`
      (3 elements). The React tree never mounts.
- [ ] S-2: No console errors — **FAIL.** Webview console is empty (tree never runs);
      the Vite dev-server overlay carries the fatal import-analysis error instead.
- [ ] S-3: Hotkeys surface reachable — **FAIL (blocked).** Settings/Hotkeys pane
      unreachable; no app UI at all. `document.documentElement` has no
      `data-fredo-hotkeys-engine` attribute.
- [ ] S-4: Telemetry Settings accessible — **FAIL (blocked).** No Settings window UI.
- [ ] S-5: Screenshot captured — **PASS (mechanically).** `.opencode/tmp/2946/e2e/baseline.jpeg`
      and `.opencode/tmp/2946/e2e/fail-vite-overlay.jpeg` captured; the latter shows
      the Vite error overlay (uploaded as user-attachment in the `## Tests Runs` verdict).
- [ ] S-6: Ctrl+Space still opens the launcher — **FAIL (blocked).** No engine, no launcher.
- [ ] S-7: A leader sequence shows pending hints — **FAIL (blocked).** No engine.
- [ ] S-8: A text field suppresses bare shortcuts — **FAIL (blocked).** No text field.
- [ ] S-9: CI-parity gate — **PARTIAL.** `pnpm --filter @fredo/ui build` exit 0;
      `pnpm --filter @fredo/ui test:run` 157 files / 2256 tests ALL PASS. These gates
      do NOT exercise the served `apps/tauri` entry, so they cannot catch this defect
      (see `.github/workflows/validate.yml` ui-validate: typecheck + build + test:run).

**Smoke verdict: FAIL (0/9 fully passing).** All live legs blocked by the app-wide
boot failure. CI-suite parity alone does not evidence the served app.

## Hotkeys smoke round 2 — result (served app boots; 8/9 PASS)

Run on `spec/2946 @ 4ad4f802` (dev-env UP, driver `com.fredo.app`, main + terminal windows).

- [x] S-1: App window renders — **PASS.** `#root` has 2 children; screenshot shows the Fredo
      desktop / Settings window. Round-1 blank-webview signature gone.
- [x] S-2: No console errors — **PASS.** Post-restart console has no
      `Error:`/`Uncaught`/`Maximum update depth exceeded` (only the pre-existing
      `motion() is deprecated` warning).
- [x] S-3: Hotkeys surface reachable — **PASS.** Settings → Hotkeys renders the single listing
      (`FREDO (GLOBAL)`, 12 rows) with `hotkeys-search-input` / `hotkeys-reset-all-button` /
      `hotkeys-reserved-list` / `hotkeys-vim-preset-toggle` / `hotkeys-macros-section`.
- [x] S-4: Telemetry Settings accessible — **PASS.** Sibling nav sections (Companion,
      Appearance, Fredo Setup, Telemetry) + feature sections all present alongside Hotkeys.
- [x] S-5: Screenshot captured — **PASS.** Multiple JPEG captures succeeded.
- [x] S-6: Ctrl+Space opens the launcher — **PASS.** From the resting desktop Ctrl+Space
      opened the launcher and focused `TEXTAREA[data-testid="launcher-command-input"]`.
- [x] S-7: Leader sequence shows pending hints — **PASS.** Vim preset leader = Space; arming
      yields `data-fredo-pending-sequence="@leader"` + the which-key overlay naming `?`.
- [x] S-8: A text field suppresses bare shortcuts — **PASS.** Typing `g?h` in the Hotkeys
      search landed verbatim; no pending sequence, no action.
- [ ] S-9: CI-parity gate — **PARTIAL.** `gh pr checks 2952` all green including
      `ui-validate` (which now runs `pnpm --filter @fredo/tauri build:webview`). The local
      `pnpm --filter @fredo/ui build` / `test:run` legs were not re-run this round (CI is the
      authority, and round 2 changed no test code).

**Smoke verdict: PASS (8/9; S-9 CI-parity delegated to the green PR checks).**

## Hotkeys smoke round 3 — result (served app boots; 9/9 live legs PASS)

Run on `spec/2946 @ 45d5120` (dev-env UP, driver `com.fredo.app`, main + terminal windows).

- [x] S-1 App window renders — **PASS.** `#root` has children; no `vite-error-overlay`.
- [x] S-2 No console errors — **PASS.** Main-window console clean across open/close,
  sequence pending, rebind, reset-all and a full dev-env restart (only the pre-existing
  `motion() is deprecated` warning).
- [x] S-3 Hotkeys surface reachable — **PASS.** Settings → Hotkeys renders ONE listing
  with three tiers: `FREDO (GLOBAL)` (13), `Infrastructure Diagram` (2),
  `MISSION MONITOR` (3); search / reset-all / reserved / vim-preset / macros all present.
- [x] S-4 Telemetry Settings accessible — **PASS.** Sibling nav sections (Companion,
  Appearance, Fredo Setup, Telemetry) stay reachable alongside Hotkeys.
- [x] S-5 Screenshot captured — **PASS.** Multiple JPEG captures succeeded.
- [x] S-6 Ctrl+Space opens the launcher — **PASS.** `TEXTAREA[launcher-command-input]`
  focused; repeated from a blurred resting desktop.
- [x] S-7 A leader sequence shows pending hints — **PASS.** Vim preset leader = Space
  armed `data-fredo-pending-sequence="@leader"` with the which-key overlay naming `?`.
- [x] S-8 A text field suppresses bare shortcuts — **PASS.** Typing `gn` into the MM
  session filter landed verbatim, `data-fredo-focus-context="text-entry"`, no pending.
- [x] S-9 CI-parity gate — **PASS (local), CI RED.** Local: `pnpm --filter @fredo/ui build`
  exit 0, `pnpm --filter @fredo/ui test:run` 161/2287 green, `pnpm --filter @fredo/tauri
  build:webview` exit 0. CI: `gh pr checks 2952` has `ui-validate` FAILED on the
  pre-existing `TerminalWindow.test.tsx#L262` terminal-sidebar race (passes locally);
  `validate` aggregator failed from that one check. `fast-validate`, `paths`,
  `rust-validate` PASS.

**Smoke verdict: PASS (9/9 live; CI `ui-validate` red on a non-feature flaky terminal test).**

## #2958 testing round 1 — quick-path results (spec/2958 @ ea0db5c)

Run on the served app (dev-env UP, `spec/2958 @ ea0db5ca`, driver `com.fredo.app`). Live receipt:
195 `telemetry_spans` in the drive window 2026-09-26 23:52:46 → 2026-09-27 00:08:54.

- [x] **S-10 PASS** — a base context is active at boot: `data-fredo-hotkey-context` /
      `data-fredo-hotkey-context-depth` publish the focus-derived base (`setup`, depth 1; after
      `g g` the base re-derived to `terminal`, depth 1). A context CHANGE renders the indicator
      text label (`hotkeys-context-indicator-label`) — not colour-only. Console clean.
- [x] **S-11 PASS** — descend + Escape quick path: `primary+K` changed the indicator to
      `Reference` / `data-depth=2` (2 pips); one Escape returned it to the previous base
      (`terminal` / 1 pip) and the announcer updated on both changes.
- [x] **S-12 PASS** — `[data-testid="hotkeys-announcer"]` text changed on the context change
      (`Entered setup. Level 1.` → `Entered Reference. Level 2.` → `Back to terminal. Top level.`);
      the region is `role="status" aria-live="polite"` and non-empty. Screenshots captured.

**Smoke verdict for #2958: PASS (S-10/S-11/S-12).**

## #2959 testing round 2 — quick-path results (spec/2959 @ a693d30)

Run on the served app (dev-env UP, `spec/2959 @ a693d30`, driver `com.fredo.app`). Live receipt:
204 `telemetry_spans` in the drive window 2026-09-27 02:20:07 → 02:32:34 (`otlp_grpc`). Console clean.

- [x] **S-1 PASS** — `#root` has 2 children; `data-fredo-hotkeys-engine="1"`; no `vite-error-overlay`.
- [x] **S-2 PASS** — no `Error:`/`Uncaught`/`Maximum update depth exceeded` before or after the drive.
- [x] **S-13 PASS** — entry/exit chord round-trips: `ctrl+shift+f8` enters (bar renders, mode hook
      set), exits (bar gone, mode hook cleared, focus restored).
- [x] **S-14 PASS** — bar persists with `data-fredo-pending-sequence` null (dwell 21.3 s stable).
- [x] **S-15 PASS** — with mode on, `primary+K` descends and one Escape restores the prior context;
      the bar rows follow; mode stays ON (no re-entry).
- [x] **S-16 PASS** — the ONE `hotkeys-announcer` fires a non-empty announcement on entry and on
      each context change (`Keyboard mode on. terminal. 23 actions: …`).
- [x] **S-9 PASS (CI)** — `gh pr checks 2973`: `ui-validate` pass, `validate` pass, `fast-validate`
      pass, `paths` pass, `rust-validate` skipping.

**Smoke verdict for #2959 round 2: PASS (all quick paths); the feature verdict is FAIL on REQ-5
(see the issue's `## Tests Runs`).**

## #2959 testing round 3 — quick-path results (spec/2959 @ 0ead7b0)

Run on the served app (dev-env UP `-Spec 2959`, driver `com.fredo.app`, main window). Live receipt:
180 `telemetry_spans` in the drive window 2026-09-27 02:55:34 → 03:05:54 (`otlp_grpc`). Console clean.

- [x] **S-1 PASS** — `#root` has 2 children; `data-fredo-hotkeys-engine="1"`; no `vite-error-overlay`
      (after a full `Down → Up`, G-046, to clear the cold-start `about:blank`).
- [x] **S-2 PASS** — no `Error:`/`Uncaught`/`Maximum update depth exceeded` before or after the drive.
- [x] **S-13 PASS** — entry/exit chord round-trips: `ctrl+shift+f8` enters (bar renders, mode hook
      set, count 23), exits (bar gone, mode/count hooks cleared, focus restored to BODY).
- [x] **S-14 PASS** — bar persists with `data-fredo-pending-sequence` null across the drive.
- [x] **S-15 PASS** — with mode on, `primary+K` descends and one Escape restores the prior context;
      the bar rows follow; mode stays ON (no re-entry).
- [x] **S-16 PASS** — the ONE `hotkeys-announcer` fires a non-empty announcement on entry and on
      each context change (`Keyboard mode on. setup. 23 actions: …`; `mission-monitor. Level 1. 26
      actions: …`).
- [ ] **S-9 PARTIAL (CI red, local green)** — local `ui-validate` parity green (`typecheck` exit 0,
      `test:run` 179 files / 2622 tests, `build:webview` exit 0); `gh pr checks 2973` reports
      `ui-validate` FAILURE (job log not retrievable in the tester sandbox — see the verdict caveats).

**Smoke verdict for #2959 round 3: PASS (all live quick paths); the feature verdict is PASS on
REQ-1..5 + NFR-1/3/4 (REQ-5 fixed), with NFR-2 carried as a named pin-only blocker.**

## Spec #2960 quick paths (typing-vs-navigating signal + zero-knowledge discovery) — **#3009 supersedes (OBSOLETE)**

> Live-plan quick paths for issue #2960 (S3). **Verification policy: live** — each carries the
> DOM/a11y assertion plus a `telemetry_spans` receipt read via the managed `psql` lever (G-284; the
> SQLite `telemetry-query` skill reads an empty/stale store on the PostgreSQL-default path).
> Selectors are REALIGNED at convergence to the Architect's FINAL BINDING names block (panel form;
> see functional.md #2960 header) — `hotkeys-keys-discovery`, `hotkeys-input-regime`,
> `hotkeys-intro`, `fredo.hotkeys.introSeen`.

- [ ] S-17: **App boots + the regime signal is present.** Load the app on the PostgreSQL-default
      path and read `data-fredo-input-regime` and the signal testid. **Expected:** `#root` mounts,
      `data-fredo-hotkeys-engine="1"`, the signal is rendered (non-colour-only) with a declared
      regime value; no `vite-error-overlay`; console clean. *(live receipt)*
- [ ] S-18: **The discovery affordance is present without any chord.** On first paint, locate
      `hotkeys-keys-discovery` with no chord pressed and no prior knowledge. **Expected:** the
      affordance is rendered and visible on the resting desktop; activating it by keyboard alone
      reveals the current context's keys; console clean. *(live receipt)*
- [ ] S-19: **Typing is stated, navigating is stated.** Focus `TEXTAREA[data-testid=
      "launcher-command-input"]` and read the signal; then blur to a non-field and re-read.
      **Expected:** the signal reads "typing" in the field and "navigating" outside it, via
      non-colour channels, with the change announced through `hotkeys-announcer`. *(live receipt)*
- [ ] S-20: **Mission Monitor still renders live sessions on the default boot path (E2E).** Boot the
      app, open Mission Monitor, drive a live session. **Expected:** the live session(s) render from
      the RTDB row pipeline and the drive window carries a `telemetry_spans` receipt via the managed
      `psql`; console clean. *(live receipt)*
  - **Edge:** G-280 orphan `postgres.exe`/stale sockets block boot → full dev-env Down → Up, then
    report (environment artifact, not a spec FAIL).

## Spec #2961 quick paths (per-app contextual actions) — **#3009 supersedes (OBSOLETE)**

> Live-plan quick paths for issue #2961 (S4). **Verification policy: live** — each carries the
> DOM/a11y assertion plus a `telemetry_spans` receipt read via the managed `psql` lever (G-284).
> Names bind to the Architect's FINAL BINDING names block (see `functional.md` #2961 header).

- [ ] S-21: **Enter keyboard mode in a named app and read its rows.** Focus a named app
      (e.g. `my-workitems`), fire the mode entry chord (`ctrl+shift+f8`), and read
      `[data-testid="hotkeys-keyboard-bar-row"]` + `data-hotkey-action` + `data-availability`.
      **Expected:** the app's declared rows appear alongside the global rows (e.g.
      `my-workitems.refresh` / `-showAllSources` / `-showAzdo` / `-showJira`), each naming its key
      and title, with the app context title visible; no other app's feature-tier rows; console
      clean. *(live receipt)*
- [ ] S-22: **Perform one app action keyboard-only.** With a named app focused + mode ON, press one
      of its declared bare keys (e.g. Feature Flags `r` refresh) and assert the app's existing
      operation runs with zero pointer events. **Expected:** the action effect is observable, no
      `mousedown`/`click`/`pointerdown` fired, console clean. *(live receipt)*

## #2961 testing round 1 — quick-path results (spec/2961 @ b1234f44)

Run on the served app (dev-env UP `-Spec 2961`, driver `com.fredo.app`, main window). Live
`telemetry_spans` receipt via the managed `psql` lever (db `postgres`, port 64217; drive
window 2026-10-04T02:00–02:35Z, `otlp_grpc`; store total 3951). Console clean of product
errors.

- [x] **S-21 PASS** — focusing `my-workitems` + `ctrl+shift+f8` renders the app's rows
      (`R Refresh work items` visible; `refresh`/`showAllSources`/`showAzdo`/`showJira` in
      the model) alongside the global rows, with the `my-workitems` context title; no other
      app's feature rows.
- [x] **S-22 PASS** — `my-workitems` `z`/`j`/`a` perform the real source-filter operation
      with `{mousedown:0,click:0,pointerdown:0}`; `r` dispatches the refresh action once.
- [x] **F-87 E2E PASS** — app boots on the PG-default path; MM renders the 7 declared
  `feature_mission_monitor_sessions` rollup rows; MM bar shows `S Focus session search`;
  live `telemetry_spans` receipt via the managed `psql` lever.

## Spec #2962 quick paths (deep nested contexts + key reuse) — **#3009 supersedes (OBSOLETE)**

> Live-plan quick paths for issue #2962 (S5). **Verification policy: live** — each carries the
> DOM/a11y assertion plus a `telemetry_spans` receipt read via the managed `psql` lever (G-284).
> Names bind to the Architect's FINAL BINDING names block (see `functional.md` #2962 header).

- [x] S-23: **PASS (2026-10-04, spec/2962 @ e39dc7e).** **Mission Monitor declares the nested chain.** Focus Mission Monitor and read the
      declared contexts. **Expected:** `mission-monitor.graph` (parent `mission-monitor`) and
      `mission-monitor.detail` (parent `mission-monitor.graph`) resolve; the bar at L1 shows
      `Sessions`; no `vite-error-overlay`; console clean. *(live receipt)*
- [x] S-24: **PASS (2026-10-04, spec/2962 @ e39dc7e).** **Descend twice + Escape unwind quick path.** With mode ON press `o` (→ Graph, depth 2),
      `o` (→ Node detail, depth 3), then Escape, Escape, Escape. **Expected:**
      `data-fredo-hotkey-context-depth` goes 1→2→3 then 3→2→1, one level per Escape; the bar rows
      follow each level; console clean. *(live receipt)*
- [x] S-25: **PASS (2026-10-04, spec/2962 @ e39dc7e).** **Reused key runs the current level's action.** At L2 press `n`; at L3 press `n`.
      **Expected:** L2 runs `mission-monitor.nextNode` (graph cursor moves), L3 runs
      `mission-monitor.nextSection` (active section moves) — the deepest level wins, no L1
      `nextSession`; the action is named for its level. *(live receipt)*

## #2962 testing round 1 — smoke results (spec/2962 @ e39dc7e)

- [x] **S-23 PASS** — bar context text `mission-monitor` (`data-depth="1"`, raw base id);
      `mission-monitor.graph` (parent `mission-monitor`) and `mission-monitor.detail`
      (parent `mission-monitor.graph`) resolve; no `vite-error-overlay`.
- [x] **S-24 PASS** — depth `1→2→3→2→1→1`, one level per Escape; bar rows follow each level.
- [x] **S-25 PASS** — L2 `n`=nextNode (cursor moves), L3 `n`=nextSection (active section
      moves); no L1 `nextSession`; action named for its level.

## Spec #3009 quick paths (always-on element-declared hotkeys)

> Live-plan quick paths for issue #3009. **Verification policy: live** — each carries the
> DOM/a11y assertion plus a `telemetry_spans` receipt via `telemetry-query.ps1` (or the
> managed `psql`/`run-exitcode.ps1` fallback on the PG-default path, G-284). Names bind to
> the Architect's FINAL BINDING names block (see `functional.md` #3009 header):
> `data-hotkey`, `data-fredo-hotkey-count`, `data-fredo-hotkeys-disabled`,
> `data-fredo-hotkey-duplicate`, `hotkeys-keybar*`, `hotkeys-duplicate-error`.

- [ ] S-26: **App boots + engine mounts + bar state is coherent.** Load the served app
      (`dev-env.ps1 -Up -Spec 3009`, `apps/tauri` entry) and read the engine + count hooks.
      **Expected:** `#root` mounts, `document.documentElement[data-fredo-hotkeys-engine="1"]`,
      `data-fredo-hotkey-count` = the number of mounted valid `data-hotkey` elements, and the
      bar (`hotkeys-keybar`) presence matches (`count ≥ 1` ⇒ present, `count === 0` ⇒ absent);
      no `vite-error-overlay`; console clean. *(live receipt)*
- [ ] S-27: **Bare-key element hotkey quick path.** Give a non-text focus to a control carrying
      `data-hotkey` (e.g. Mission Monitor session search `s`) and press the bare key.
      **Expected:** the element's action runs (the app's real operation), exactly once, with no
      modifier; the key is listed in the bar; console clean. *(live receipt)*
- [ ] S-28: **Always-on bar: aggregation + zero state.** With ≥1 element hotkey mounted, read the
      bar; then open a window mounting zero `data-hotkey` elements and re-read. **Expected:** with
      ≥1 the bar renders app-wide listing every element key in document order (element-only); at
      0 the bar is hidden and `data-fredo-hotkey-count="0"`. *(live receipt)*
- [ ] S-29: **Text-entry suppression quick path.** Focus `TEXTAREA[data-testid=
      "launcher-command-input"]` and press a bare element key. **Expected:** the character lands
      verbatim in the field and NO hotkey fires; every bar row is
      `data-hotkey-availability="disabled"`; `data-fredo-hotkeys-disabled="true"`; console clean.
      *(live receipt)*
- [ ] S-30: **CI-parity gate.** Run `pnpm --filter @fredo/ui build` (expect exit 0, zero TS
      errors), `pnpm --filter @fredo/ui test:run` (green), and the served
      `pnpm --filter @fredo/tauri build:webview` leg. **Expected:** all pass with no
      weakened/disabled assertion. Cross-ref `regression.md` R-47.


