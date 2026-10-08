# workspace-layout — Regression Baseline

The "must not change" baseline for the customizable workspace, now the **FancyZones-style zone model** (issue #2980, replacing the shipped 9-region arrangement UX #2949). Run on every testing phase that touches the window/workspace surface. The zone layer is ADDITIVE — the #2807/#2924 window kernel contract, the #2924 full-bleed default, freeform float geometry, the launcher/dock read-only consumption, and token-first theming must all behave exactly as before. The old arrangement path (toolbar/presets/grip overlay/`PaneDivider`/`LayoutMenu` + the launcher dock "Arrange" well) is **REMOVED** — exactly one arrangement model persists. Links to overlapping prior/deferred suites below.

> **Verification policy: live** — the window/workspace surface is a rendering+persistence surface; each run needs the established live reference: a `telemetry_spans` live query via `.opencode/skills/telemetry-query/telemetry-query.ps1` (non-zero count + recent `max(ingested_at)`) at round start AND after the drive, plus DOM/screenshot/console receipts per leg. A static-only PASS is a FALSE PASS.

## Must NOT change (regression invariants)

- [ ] R-1 (single-window / full-bleed default — #2924): Open one feature with layout management OFF (the store default).
  - EXPECTED: it opens full-bleed at the kernel default (`windowStore.ts:105`) via `Home.tsx:103` — rect `{0,0,hostW,hostH}`, `borderRadius:0`, 0 grips, control "Restore …" with `aria-expanded`; Restore returns a centered, cascade-free float (480×320, radius 8px, 8 grips). The zone layer must NOT change the kernel default or the `Home.tsx` call site.
  - Edge: a raw `openWindow` consumer opens full-bleed; maximize→restore after the zone model ships; maximize→restore returns the edited float.
- [ ] R-2 (window-kernel contract): `windowStore.ts` / `windowTypes.ts` open/close/update/focus contract is unchanged — `updateWindow` is a spread-merge (never full replacement), `closeWindow` removes the entry BEFORE the callback (idempotent, re-entrancy-guarded), one window per feature id, focus brings a window topmost without a focus steal.
  - EXPECTED: `windowStore.test.ts` invariants still pass; a re-entrant close does not loop/crash; update-while-minimized does NOT auto-restore or steal focus.
  - Edge: rapid double-open; close from any z-order; `WindowEntry` carries NO geometry field (zone stores ids + fractional rects only).
- [ ] R-3 (freeform float stays frame-local when layout management is OFF): `WindowFrame.tsx` geometry is still component-local state; `windowGeometry.ts` remains the single pure geometry rule.
  - EXPECTED: dragging/resizing an unassigned window produces the same float behavior as #2924; `resolveFloatGeometry`/`clampToWorkspace` unit tests green; no geometry field added to the kernel store; the zone renderer never adds geometry to the kernel store.
  - Edge: float an unassigned window over a zoned pane (z-order); drag clamp at the workspace edges.
- [ ] R-4 (old arrangement path REMOVED / zone-off is inert — AC5, #2980; retires R-4'): with layout management ON and OFF, inspect the DOM and drive a plain drag.
  - EXPECTED: the removed hooks are ALL ABSENT from the DOM — `workspace-toolbar`, `workspace-preset-*`, `workspace-arrange`, `dock-arrange`, `pane-region-*`, `pane-divider-*`, `layout-menu-button`, `workspace-announcer`; there is no competing arrange/placement affordance and exactly one `zone-announcer` (owned by `ZoneOverlay.tsx`). `workspace-layout` (root) is KEPT as the overlay/partition host.
  - EXPECTED (OFF baseline): with `enabled=false` (or no layout assigned) NO `zone-*` overlay appears, `zone-overlay` is never mounted, `data-zone-drag` is never set, and a window drag behaves EXACTLY as the shipped freeform float (R-3).
  - Edge: the retired `dock-arrange`/positionable-dock expectations (formerly R-4/R-4') are dropped — the dock is a pure read-only consumer and exposes no arrange entry; a chord-drag with layout management off is a no-op.
- [ ] R-5 (launcher + `open-app` open path): the launcher tile and the `fredo open-app` CLI path still open a feature window through the full-lifecycle `openFeatureWindow`.
  - EXPECTED: both open one window per feature id with the brand chrome; no duplicate frame; reference `.opencode/tests/launcher/` + `.opencode/tests/run-cli/`.
  - Edge: `openSelf()` path; reopening an already-open feature re-focuses.
- [ ] R-6 (theming contract — token-first, no hardcoded color): all zone/overlay/pane-target colors come from theme semantic tokens → CSS vars → user theme; tints via the shared `tint()` helper.
  - EXPECTED: zero hardcoded hex/rgba and zero `var(--x)NN` alpha-append in changed files; zone overlay/pane chrome re-tints under light/dark + accent override; reference `.opencode/tests/theming/` + `.opencode/tests/settings/`.
  - Edge: a `var(--x)22` alpha-append or a fixed accent purple ignoring the user accent is a FAIL (#2770 round 5 precedent).
- [ ] R-7 (keyboard / window traversal — #2946): the existing window traversal and hotkeys still work while the zone model ships.
  - EXPECTED: `useWindowTraversal` Tab-boundary behavior is unchanged; window ops (close/minimize/maximize/focus) remain reachable; the zone model adds NO keyboard capture/conflict. **The activation chord is modifier-only and lives OUTSIDE the keymap engine** — `normalizeKeyStroke` (`keys.ts:314-352`) rejects pure modifier keydowns, so the chord is tracked from the pointer event's modifier flags (`matchesZoneChord`, reusing `resolvePrimaryModifier` `keys.ts:158-160`) and the engine's single capture listener + dispatch (`engine.ts:678-712`) is untouched (no second `keydown` listener, no dispatch change). Reference `.opencode/tests/hotkeys/`.
  - Edge: hold the chord then pointer-drag (no keydown recorded by the engine); Ctrl+Tab between windows while a zone pane is focused.
- [ ] R-8 (settings surface — #2868/#2948/#2980): the Settings window (`SettingsSurface.tsx`) still renders its sidebar nav (Companion / Appearance / Fredo Setup / Telemetry / Hotkeys / feature tabs) with no broken section; the new static **Layout** section is ADDITIVE (`settings-nav-layout` → `layout-settings`) and does not break `ThemingSettings`/`BackgroundSettings` or any other section.
  - EXPECTED: Settings opens as a normal feature window; every other static section renders unchanged; the Layout section hosts `layout-enabled-toggle`, `layout-active-select`, `layout-gap-input`, `layout-chord-select`, `layout-new-button`; build green.
  - Edge: settings window open while zoned windows are active; theme switch from Settings re-tints the panes.
- [ ] R-9 (store isolation / unbounded structures): the zone store adds no unbounded structure beyond the open-window count; persistence payload ≤ 16 KB for ≤ 12 zoned zones/assignments; `WindowEntry` (ReactNode fields) is never serialized.
  - EXPECTED: `resetZoneLayoutStoreForTests()` exists; persisted JSON holds only ids + fractions + numbers (key `Fredo_layout_zones` v1); no `icon`/`component` in the JSON; snapshot reference is stable until a real mutation; the legacy `Fredo_workspace_layout` key is purged (never migrated).
  - Edge: 12 zones; corrupt persisted JSON; unknown version; unknown `windowId` KEPT (degraded render).
- [ ] R-10 (no re-render loop / console clean): after every zone + window interaction the console is clean.
  - EXPECTED: no `Error:`/`Uncaught`/`Maximum update depth exceeded`; effects consume epoch/primitive signals; no array `.length` / fresh object refs in deps; the transient drag snapshot identity changes only on a real mutation; the overlay transition animates only opacity.
  - Edge: rapid chord-drag repeat, repeated save/restore, theme flip.
- [ ] R-11 (build + tests green / no weakened assertions): `pnpm --filter @fredo/ui typecheck` + `build` + `test:run` green; `cargo check/test/clippy --locked` green when Rust is touched; no existing assertion weakened/disabled/deleted.
  - EXPECTED: full CI-parity set exits 0 with zero warnings; `windowStore.test.ts` + `windowGeometry.test.ts` + `zoneLayout.test.ts` + `zoneLayoutStore.test.ts` stay green.
  - Edge: a red local gate predicts a red PR check.

## Overlapping prior-feature suites

- `.opencode/tests/window-manager/` — the kernel, full-bleed default, float, and lifecycle (R-1..R-15). Primary regression surface.
- `.opencode/tests/launcher/` + `.opencode/tests/run-cli/` — the feature-open paths into windows; the launcher exposes no arrange entry (R-4).
- `.opencode/tests/settings/` + `.opencode/tests/theming/` — the Layout section is added as a static nav section; token re-tint on theme/accent change.
- `.opencode/tests/hotkeys/` — window traversal / keyboard parity; the modifier-only chord stays outside the engine (R-7).
- `.opencode/tests/mission-monitor/` — the zoned pane's feature content (Mission Monitor ≡ Sessions) must render inside a zoned pane exactly as inside a window.

## CI-parity baseline

- [ ] S-CI: the local `validate.yml` command set (`CONTRIBUTING.md:32-43`) is green on the spec tip — `pnpm --filter @fredo/ui typecheck`, `pnpm --filter @fredo/ui build`, `pnpm --filter @fredo/ui test:run`, `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`, `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`, `cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings`. A workspace-layout change must not break any leg.
