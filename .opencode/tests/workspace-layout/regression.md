# workspace-layout — Regression Baseline

The "must not change" baseline for the customizable workspace (issue #2949). Run on every testing phase that touches the window/workspace surface. The tiling layer is ADDITIVE — the #2807/#2924 window kernel contract, the #2924 full-bleed default, freeform float geometry, and the #2848 dock must all behave exactly as before. Links to overlapping prior/deferred suites below.

> **Verification policy: live** — the window/workspace surface is a rendering+persistence surface; each run needs the established live reference: a `telemetry_spans` live query via `.opencode/skills/telemetry-query/telemetry-query.ps1` (non-zero count + recent `max(ingested_at)`) at round start AND after the drive, plus DOM/screenshot/console receipts per leg. A static-only PASS is a FALSE PASS.

## Must NOT change (regression invariants)

- [ ] R-1 (single-window / full-bleed default — #2924): Open one feature with no tiled arrangement active.
  - EXPECTED: it opens full-bleed at the kernel default (`windowStore.ts:105`) via `Home.tsx:103` — rect `{0,0,hostW,hostH}`, `borderRadius:0`, 0 grips, control "Restore …" with `aria-expanded`; Restore returns a centered, cascade-free float (480×320, radius 8px, 8 grips). The tiling layer must NOT change the kernel default or the `Home.tsx` call site.
  - Edge: a raw `openWindow` consumer opens full-bleed; maximize→restore after the workspace ships; maximize→restore returns the edited float.
- [ ] R-2 (window-kernel contract): `windowStore.ts` / `windowTypes.ts` open/close/update/focus contract is unchanged — `updateWindow` is a spread-merge (never full replacement), `closeWindow` removes the entry BEFORE the callback (idempotent, re-entrancy-guarded), one window per feature id, focus brings a window topmost without a focus steal.
  - EXPECTED: `windowStore.test.ts` invariants still pass; a re-entrant close does not loop/crash; update-while-minimized does NOT auto-restore or steal focus.
  - Edge: rapid double-open; close from any z-order; `WindowEntry` carries NO geometry field (layout stores ids + rects only).
- [ ] R-3 (freeform float stays frame-local when no tiled layout is active): `WindowFrame.tsx` geometry is still component-local state; `windowGeometry.ts` remains the single pure geometry rule.
  - EXPECTED: dragging/resizing a no-slot window produces the same float behavior as #2924; `resolveFloatGeometry`/`clampToWorkspace` unit tests green; no geometry field added to the kernel store.
  - Edge: float a no-slot window over a tiled arrangement (z-order); drag clamp at the workspace edges.
- [ ] R-4 (positionable dock — #2848 stays a pure read-only consumer): `AppDock` continues to consume `useWindows()`/`useWindowActions()` only, and the dock position setting persists.
  - EXPECTED: Sidebar ↔ Bottom bar selection still relocates the dock immediately and survives a full restart; the dock lists every open window once; empty gate (0 windows → no dock). The dock stays a `useWindows()` reader for its entry list; the ONLY sanctioned layout-store write is the `dock-arrange` tiling entry (Spec #2949 AC1), which dispatches the shared `arrangeOpenWindows()` action — no other dock write into the layout store, no layout store write into the kernel. Round-2 note: prior wording said "no dock write into the layout store"; the Architect's round-2 Fix Plan authorizes the `dock-arrange` entry, so that clause is scoped to the sanctioned tiling entry only.
  - Edge: reveal/hide over a maximized window; entry ✕ close only that app; reference `.opencode/tests/app-dock/`.
- [ ] R-5 (launcher + `open-app` open path): the launcher tile and the `fredo open-app` CLI path still open a feature window through the full-lifecycle `openFeatureWindow`.
  - EXPECTED: both open one window per feature id with the brand chrome; no duplicate frame; reference `.opencode/tests/launcher/` + `.opencode/tests/run-cli/`.
  - Edge: `openSelf()` path; reopening an already-open feature re-focuses.
- [ ] R-6 (theming contract — token-first, no hardcoded color): all pane/divider/drop-target colors come from theme semantic tokens → CSS vars → user theme; tints via the shared `tint()` helper.
  - EXPECTED: zero hardcoded hex/rgba and zero `var(--x)NN` alpha-append in changed files; pane chrome re-tints under light/dark + accent override; reference `.opencode/tests/theming/` + `.opencode/tests/settings/`.
  - Edge: a `var(--x)22` alpha-append or a fixed accent purple ignoring the user accent is a FAIL (#2770 round 5 precedent).
- [ ] R-7 (keyboard / window traversal — #2946): the existing window traversal and hotkeys still work while the workspace feature ships.
  - EXPECTED: `useWindowTraversal` Tab-boundary behavior is unchanged; window ops (close/minimize/maximize/focus) remain reachable; divider/pane keyboard nav does not capture or conflict with window traversal. Reference `.opencode/tests/hotkeys/`.
  - Edge: divider focused then Tab; Ctrl+Tab between windows while a pane is focused.
- [ ] R-8 (settings surface — #2868/#2948): the Settings window (`SettingsSurface.tsx`) still renders its sidebar nav (Companion / Appearance / Fredo Setup / Telemetry / Hotkeys / feature tabs) with no broken section; any workspace-layout control is additive (e.g. under Appearance) and does not break `DockPositionSettings`/`ThemingSettings`/`BackgroundSettings`.
  - EXPECTED: Settings opens as a normal feature window; Appearance renders dock-position + theming + background controls unchanged; build green.
  - Edge: settings window open while a tiled arrangement is active; theme switch from Settings re-tints the panes.
- [ ] R-9 (store isolation / unbounded structures): the layout store adds no unbounded structure beyond the open-window count; persistence payload ≤ 16 KB for ≤ 12 panes; `WindowEntry` (ReactNode fields) is never serialized.
  - EXPECTED: `resetWorkspaceLayoutStoreForTests()` exists; persisted JSON holds only ids + regions + rects; no `icon`/`component` in the JSON; snapshot reference is stable until a real mutation.
  - Edge: 12 panes; corrupt persisted JSON; unknown version.
- [ ] R-10 (no re-render loop / console clean): after every workspace + window interaction the console is clean.
  - EXPECTED: no `Error:`/`Uncaught`/`Maximum update depth exceeded`; effects consume epoch/primitive signals; no array `.length` / fresh object refs in deps.
  - Edge: rapid divider drag, repeated save/restore, theme flip.
- [ ] R-11 (build + tests green / no weakened assertions): `pnpm --filter @fredo/ui typecheck` + `build` + `test:run` green; `cargo check/test/clippy --locked` green when Rust is touched; no existing assertion weakened/disabled/deleted.
  - EXPECTED: full CI-parity set exits 0 with zero warnings; `windowStore.test.ts` + `windowGeometry.test.ts` + `dockPositionStore.test.ts` stay green.
  - Edge: a red local gate predicts a red PR check.

## Overlapping prior-feature suites

- `.opencode/tests/window-manager/` — the kernel, full-bleed default, float, and lifecycle (R-1..R-15). Primary regression surface; run F-19 of `functional.md`.
- `.opencode/tests/app-dock/` — the positionable dock (#2848) is the adjacent persistent consumer; must stay a pure `useWindows()` reader.
- `.opencode/tests/launcher/` + `.opencode/tests/run-cli/` — the feature-open paths into panes.
- `.opencode/tests/settings/` + `.opencode/tests/theming/` — a workspace control may be added under Appearance; token re-tint on theme/accent change.
- `.opencode/tests/hotkeys/` — window traversal / keyboard parity.
- `.opencode/tests/mission-monitor/` + `.opencode/tests/terminal/` — the panes' feature content (Mission Monitor ≡ Sessions; Terminal) must render inside a pane exactly as inside a window.

## CI-parity baseline

- [ ] S-CI: the local `validate.yml` command set (`CONTRIBUTING.md:28-35`) is green on the spec tip — `typecheck`, `build`, `test:run`, `cargo check --locked`, `cargo test --locked`, `cargo clippy --locked -- -D warnings`. A workspace-layout change must not break any leg.
