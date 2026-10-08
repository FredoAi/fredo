# workspace-layout — Functional

Scope: the FancyZones-style **zone layout** workspace (issue #2980) — layout management is configured in a dedicated **Layout** settings section (enable, define/edit layouts, assign, zone gap, activation chord), and windows are snapped into zones by **holding the activation chord and dragging the window header**: the zone overlay appears, the zone under the pointer highlights, release snaps the window into that zone. Config + assignments persist across restart, and zoned windows restore into their zones on first paint. This REPLACES the shipped 9-region arrangement UX (#2949 workspace toolbar/presets/grip overlay/`PaneDivider`/`LayoutMenu`, dock "Arrange" well). Built on the own window kernel (`apps/ui/src/shared/window-system/`). Map 1:1 to `.opencode/tmp/2980/triage.md` `## QA Expert` (rows R-1.1..R-5.2 + E2E + RESTART; Architect EARS R-1..R-5, AC1..AC5). A FAIL on any AC-mapped F-row fails that AC.

> **Verification policy: live** — UI-rendering + persistence + gesture spec; the ACs are provable ONLY by observing the running artifact (`pnpm dev:tauri`). Each leg: DOM-snapshot with `getBoundingClientRect` reads, `tauri_webview_screenshot` receipt, `tauri_read_logs(source="console")` after every step. **Live-gate reference:** the round's Evidence MUST include a `telemetry_spans` live query via `.opencode/skills/telemetry-query/telemetry-query.ps1` (non-zero count + recent `max(ingested_at)` at round start AND after the drive). Layout state is row-INDEPENDENT (windows derive from the `useWindows()` store; zone config from the module-scoped zone store) — the query is the live-pipeline reference, not a layout metric. A static-only PASS is a FALSE PASS; the audit gate fails closed. A console `Error:`/`Uncaught`/`Maximum update depth exceeded` on any leg invalidates that leg.

> **Authoritative surface (do not substitute names).** Store `apps/ui/src/shared/window-system/zoneLayoutStore.ts` (module-scoped, `useSyncExternalStore`, stable snapshot ref until a real mutation); hook `useZoneLayout()`; pure math `apps/ui/src/shared/window-system/zoneLayout.ts`; key `Fredo_layout_zones` (JSON v1 `{version, enabled, activeLayoutId, layouts, gap, chord, assignments}`); legacy `Fredo_workspace_layout` is NOT migrated and is best-effort purged on first hydrate. Constants: `ZONE_LAYOUT_VERSION=1`, `DEFAULT_ZONE_GAP=8`, `MIN_ZONE_GAP=0`, `MAX_ZONE_GAP=32`, `DEFAULT_ZONE_CHORD='alt'`, `ZONE_ACTIVATION_CHORDS=['alt','primary','primary+alt','primary+shift','alt+shift']`. Renderer `ZoneOverlay.tsx` + rewritten `WorkspacePane.tsx` + `WindowManager.tsx` zone partition; settings host `features/settings-app/components/LayoutSettings.tsx` + `ZoneLayoutEditor.tsx`, wired as a STATIC "Layout" section in `SettingsSurface.tsx`. **Units:** a zone rect is a fraction 0..1 of the measured workspace; the rendered window px rect = `zone.rect × workspace`, inset `gap/2` per side, clamped to MIN 320×200; `gap` is px. The activation chord is MODIFIER-ONLY and is tracked from pointer-event modifier flags (`altKey`/`ctrlKey`/`metaKey`/`shiftKey`) — NOT the keymap engine; the `primary` token uses `resolvePrimaryModifier()`. `windowId` = `FredoFeatureClass.id` (`terminal`, `mission-monitor`, `diagram`). **Testid hooks:** `settings-nav-layout`, `layout-settings`, `layout-enabled-toggle`, `layout-active-select`, `layout-gap-input`, `layout-chord-select`, `layout-list-item-<id>`, `layout-assign-<id>`, `layout-delete-<id>`, `layout-new-button`, `layout-edit-<id>`, `layout-editor`, `layout-editor-name`, `layout-template-<templateId>`, `layout-template-count`, `layout-template-main-fraction`, `layout-editor-preview`, `layout-editor-zone-<zoneId>`, `layout-editor-split-h`, `layout-editor-split-v`, `layout-editor-confirm`, `layout-editor-cancel`, `layout-editor-error`, `zone-overlay`, `zone-target-<zoneId>` (+`data-zone-id`/`data-hovered`), `zone-announcer`, `workspace-pane-<windowId>` (+`data-zone-id`), `zone-degraded-<windowId>`, `workspace-empty-slot-<windowId>`, `workspace-slot-restore-<windowId>`, `data-zone-drag='true'`. **REMOVED hooks that must be ABSENT (R-5.1):** `workspace-toolbar`, `workspace-preset-*`, `workspace-arrange`, `dock-arrange`, `pane-region-*`, `pane-divider-*`, `layout-menu-button`, `workspace-announcer`. **Induction lever:** `tauri_ipc_execute_command('save_setting',{key:'Fredo_layout_zones',value:<json>})` then restart + read back `get_setting` (existing command pair; no new Rust command). **Before→after:** where an AC is before→after, the BEFORE state = the pre-feature app (layout management OFF / shipped 9-region toolbar); the BEFORE column may use a removed-code diff + durable recorded values. A live baseline, if required, is `dev-env.ps1 -Action Up -Spec 2980 -At <pre-change-tip>` (restore to the tested tip after); do NOT require a second `git worktree` (denied in the tester sandbox).

## AC1 — one Layout settings area (R-1.1..R-1.3)

- [ ] F-1 (R-1.1 / AC1): Boot PG-default; open Settings; click `[data-testid="settings-nav-layout"]`.
  - EXPECTED: the `[data-testid="layout-settings"]` pane renders and hosts `layout-enabled-toggle`, `layout-active-select`, `layout-gap-input`, `layout-chord-select`, and `layout-new-button` (plus the defined-layout list). Exactly one Layout nav item exists.
  - Edge: other static Settings sections untouched (Hotkeys still renders); re-open Settings → Layout is still the surface; the nav item is `aria-current="page"` when active and keyboard-reachable.
- [ ] F-2 (R-1.2 / AC1): In `layout-settings`, toggle `layout-enabled-toggle` on; pick a layout in `layout-active-select`; set `layout-gap-input` = 16; pick `layout-chord-select` = `primary+alt`.
  - EXPECTED: each change applies to the running workspace with NO relaunch (dependent controls un-dim; the active layout takes effect; rendered zone rects reflect gap 16; the chosen chord is what `matchesZoneChord` accepts) and persists via `save_setting('Fredo_layout_zones')` (read back shows enabled/active/gap/chord).
  - Edge: `layout-gap-input` out of 0–32 clamps/reverts via `clampZoneGap` (caption "0–32 px"); `layout-active-select` disabled when `enabled=false` OR `layouts.length===0` ("Define a layout first"); `layout-chord-select` disabled when `enabled=false`.
- [ ] F-3 (R-1.3 / AC1): After F-2, fully restart the app; reopen Settings → Layout.
  - EXPECTED: the persisted enabled flag, active layout, defined layouts, gap, and chord reload and re-apply (values match); read back via `get_setting('Fredo_layout_zones')`.
  - Edge: malformed / `version!==1` payload → defaults (no throw); legacy `Fredo_workspace_layout` purged on first hydrate.

## AC2 — define/edit layouts (R-2.1..R-2.5)

- [ ] F-4 (R-2.1 / AC2): Click `layout-new-button`; for each of `layout-template-columns`, `layout-template-rows`, `layout-template-grid`, `layout-template-main-side` click the template and adjust `layout-template-count` / `layout-template-main-fraction`.
  - EXPECTED: `layout-editor-preview` paints the expected `layout-editor-zone-<zoneId>` tiles for each template within <100 ms; a `main-side` layout exposes `layout-template-main-fraction`.
  - Edge: custom split — select a `layout-editor-zone-<zoneId>` then `layout-editor-split-h` / `layout-editor-split-v` adds a zone (`splitZone` at 0.5); split buttons disabled until a zone is selected.
- [ ] F-5 (R-2.2 / AC2): Set `layout-editor-name`; click `layout-editor-confirm`.
  - EXPECTED: `saveZoneLayout` persists; the editor closes; a `layout-list-item-<id>` appears with its zone/template summary and a status message announces.
  - Edge: empty name → `layout-editor-error` shown, confirm blocked; the saved layout survives restart; `layout-editor-cancel` discards with no store write.
- [ ] F-6 (R-2.3 / AC2): Click `layout-assign-<id>` (or select it in `layout-active-select`).
  - EXPECTED: the running workspace uses it as active (`setActiveZoneLayout`); the row shows an "Active" text pill + `aria-current="true"`.
  - Edge: assigning another layout switches active; deleting the active layout clears it.
- [ ] F-7 (R-2.4 / AC2): In `layout-editor` remove all zones and attempt confirm; render a zero-zone layout's `layout-assign-<id>`.
  - EXPECTED: `layout-editor-confirm` disabled; `layout-editor-error` explains; `layout-assign-<id>` disabled; `setActiveZoneLayout` is a no-op (no active change, no throw).
  - Edge: a zero-`zones[]` layout does not survive reload (dropped by tolerant parse); the pure no-op assertion is a `static/unit pin — non-AC` where no live lever reaches it.
- [ ] F-8 (R-2.5 / AC2): Assign a layout; click `layout-edit-<id>`, change its zones, confirm.
  - EXPECTED: the workspace re-renders against the edited zones; other windows uncorrupted; no throw; status announces.
  - Edge: draft edits leave the workspace unchanged until confirm; `layout-editor-cancel` discards.

## AC3 — chord-drag snap (R-3.1..R-3.4)

- [ ] F-9 (R-3.1 / AC3): Precondition enabled + `activeLayoutId` + a live window; hold the activation chord, pointer-down on `[data-testid="window-frame-<id>"]` header, drag across the workspace.
  - EXPECTED: `[data-testid="zone-overlay"]` + one `zone-target-<zoneId>` per zone appear; the dragged frame gets `data-zone-drag="true"`; the zone under the pointer sets `data-hovered="true"` (others idle); `[data-testid="zone-announcer"]` announces overlay/target.
  - Edge: chord held but pointer-down NOT on the header → no overlay; eligibility gate read at pointer-down; zero-layout active → no overlay.
- [ ] F-10 (R-3.2 / AC3): From F-9, release the pointer over a hovered `zone-target-<zoneId>`.
  - EXPECTED: the window renders as `[data-testid="workspace-pane-<windowId>"]` with `data-zone-id`; its px rect lies within `resolveZoneRect` (fraction×workspace, `gap/2` inset per side, clamped ≥320×200); the assignment persists (`save_setting`) and `zone-announcer` announces "Snapped {title} to {zone}".
  - Edge: adjacent zones leave an even gutter (`gap/2` per edge); `gap=0` → flush; overlapping zones pick the topmost.
- [ ] F-11 (R-3.3 / AC3): Turn `layout-enabled-toggle` off (or set active = "None"); chord-drag a window.
  - EXPECTED: no `zone-overlay`; the drag behaves exactly as the shipped freeform float; `data-zone-drag` never set.
  - Edge: enabled but zero layouts → same no-overlay / float behavior.
- [ ] F-12 (R-3.4 / AC3): Chord-drag and release over an inter-zone gap / outside the workspace; separately press Escape mid-drag.
  - EXPECTED: no highlight (`hoveredZoneId=null`); geometry unchanged; no assignment; no throw; `zone-announcer` "No zone — window unchanged." / "Snap cancelled — window unchanged."; focus is not moved.
  - Edge: Escape on a non-eligible drag is a no-op.

## AC4 — it sticks (R-4.1..R-4.4)

- [ ] F-13 (R-4.1 / AC4): Fully restart after config changes (F-2).
  - EXPECTED: enabled flag, `activeLayoutId`, defined layouts, gap, and chord survive and reload (read back via `get_setting`).
  - Edge: malformed payload → defaults; legacy key purged.
- [ ] F-14 (R-4.2 / AC4): With assignments persisted, fully restart.
  - EXPECTED: each assignment whose window resolves to a REGISTERED feature reopens un-maximized and renders in its zone on FIRST paint (`workspace-pane-<windowId>` with `data-zone-id`).
  - Edge: feature off after restart → no reopen; a `new-window` app is never zone-managed.
- [ ] F-15 (R-4.3 / AC4): With enabled + assigned layout + zoned windows open, force a `WindowManager`/Home remount.
  - EXPECTED: every open assigned window renders at its zone's resolved rect and continues to across the remount.
  - Edge: a gap/chord change re-renders all zoned windows; the module-scoped store survives remount (no `useRef`/`useState`).
- [ ] F-16 (R-4.4 / AC4): Seed a persisted assignment with an unregistered/closed windowId (lever below), then restart.
  - EXPECTED: its zone renders `[data-testid="zone-degraded-<windowId>"]` (minimized → `workspace-empty-slot-<windowId>`); sibling zones/windows unchanged; nothing throws.
  - Edge: `workspace-slot-restore-<windowId>` restores a minimized zoned pane; lever = `tauri_ipc_execute_command('save_setting',{key:'Fredo_layout_zones',value:<json-with-unknown-windowId>})`, restart, read back `get_setting`.

## AC5 — old path removed, kernel unchanged (R-5.1, R-5.2)

- [ ] F-17 (R-5.1 / AC5): Boot; scan the DOM with layout management both on and off.
  - EXPECTED: `workspace-toolbar`, `workspace-preset-*`, `workspace-arrange`, `dock-arrange`, `pane-region-*`, `pane-divider-*`, `layout-menu-button`, and `workspace-announcer` are ALL absent; exactly one `zone-announcer` exists.
  - Edge: the launcher/dock expose no arrange entry; `workspace-layout` root KEPT as the overlay/partition host.
- [ ] F-18 (R-5.2 / AC5): PG-default boot; open/float/dock a window with the feature off.
  - EXPECTED: kernel contract unchanged — single-window full-bleed default, freeform float math (`windowGeometry`), launcher/dock a read-only `useWindows()` consumer, token-first theming; kernel suites pass.
  - Edge: no new Rust command/table; `WindowEntry` ReactNode never serialized.

## End-to-end (MISSION-MONITOR)

- [ ] F-19 (E2E / AC1+AC2+AC3+AC4): Boot PG-default; open Mission Monitor + Terminal from the launcher; Settings → Layout → enable + `layout-new-button` → `layout-template-columns` ×2 → `layout-editor-confirm` → `layout-assign-<id>`; hold the chord and drag each header over a zone (overlay + highlight + release); restart.
  - EXPECTED: Mission Monitor renders live sessions in its window; overlay/highlight/snap work live; after restart both windows return to their zones on first paint and Mission Monitor still streams live sessions inside its zoned pane.
  - Edge: the live-session reference is observed via `telemetry_spans` / row pipeline; a `telemetry_spans` non-zero count + recent `max(ingested_at)` bookends the round.

## RESTART / persistence

- [ ] F-20 (RESTART): Fully restart with a complete payload (enabled + active + layouts + gap + chord + assignments).
  - EXPECTED: all config AND assignments survive; zoned windows restore on first paint; exactly one arrangement model persists under `Fredo_layout_zones` v1.
  - Edge: unrelated settings unaffected; hydrate is once-only / dirty-guarded; `Fredo_workspace_layout` absent after purge.

## Non-functional

- [ ] F-21 (loop guard): After EVERY chord-drag/snap/assign/layout edit/restart and a theme flip, read the webview console; grep the changed zone/settings code.
  - EXPECTED: no `Maximum update depth exceeded`/`Error:`/`Uncaught`; effect/memo deps consume epoch/primitive signals — no array `.length`, no freshly-created object refs; the transient drag snapshot identity changes only on a real mutation.
  - Edge: rapid repeat drags; repeated edit/assign; theme flip mid-arrangement.
- [ ] F-22 (token-first): Inspect the computed styles of `zone-overlay`/`zone-target-*`/`workspace-pane-*`/`layout-settings` under two themes + a user accent override; static grep over changed files.
  - EXPECTED: computed bg/border/fill trace to semantic tokens / CSS vars (`--card-bg`/`--border-color`/`--accent-primary`); tints via `tint()` (`color-mix`); ZERO `#[0-9a-fA-F]{3,8}`, ZERO `rgba(`/`hsla(`, ZERO `var(--x)NN` alpha-append (excluding issue-ref comments / documented data-palette exemptions).
  - Edge: light + dark; the hovered `zone-target` non-colour cue (glyph + label) still reads with hue off; any fixed non-token colour is a FAIL.
- [ ] F-23 (keyboard reachability): Tab through `layout-settings` + `layout-editor`.
  - EXPECTED: every control is a native control reachable in DOM order with the global `:focus-visible` ring; the Layout nav item is `aria-current="page"` when active; template buttons form a labelled `radiogroup` (`aria-checked`); preview zones carry `aria-pressed`.
  - Edge: narrow viewport; empty layout list; editor open; no focus trap (`aria-modal`/`inert` absent).
- [ ] F-24 (drag focus): Chord-drag a window; press Escape mid-drag; complete a snap.
  - EXPECTED: the drag does not move or trap focus (`handleHeaderPointerDown` `preventDefault()`s; no `.focus()` in begin/end/cancel); Escape cancels with no focus change; no `aria-modal`/`inert`/focus-trap in the drag path.
  - Edge: drag from a focused vs unfocused window; a non-eligible drag (no chord) leaves focus as-is.
- [ ] F-25 (WindowEntry never serialized): Read back `get_setting('Fredo_layout_zones')`.
  - EXPECTED: the persisted payload holds ids + fractions + numbers only — no ReactNode/function/component fields; `WindowEntry` (`windowTypes.ts`) is never serialized.
  - Edge: an assignment to a `new-window` app is excluded; a malformed payload is tolerated.

## Regression + CI

- [ ] F-26 (regression): Run `.opencode/tests/window-manager/` (functional F-3..F-11 + regression R-1..R-15) while the workspace zone feature ships.
  - EXPECTED: open → maximize → restore → minimize → focus → close behaves exactly as #2924; one window per feature id; no focus steal; close idempotent/re-entrancy-guarded; freeform float geometry stays frame-local; the launcher/dock stays a read-only `useWindows()` consumer.
  - Edge: rapid re-open; update-while-minimized; maximize→restore geometry; dock position/reveal; launcher open.
- [ ] F-27 (CI-parity): Run the exact `CONTRIBUTING.md` command set on the spec tip.
  - EXPECTED: `pnpm --filter @fredo/ui typecheck`, `pnpm --filter @fredo/ui build`, `pnpm --filter @fredo/ui test:run`, `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`, `cargo test … --locked`, `cargo clippy … --locked -- -D warnings` — every step exits 0 with zero warnings; no existing assertion weakened/disabled/deleted.
  - Edge: Rust touched → cargo legs required; UI-only → UI legs required; a red local gate predicts a red PR check.

## F-row → AC map

F-1/F-2/F-3 → AC1 (one Layout settings area); F-4/F-5/F-6/F-7/F-8 → AC2 (define/edit/assign layouts, zero-zone guard, live edit); F-9/F-10/F-11/F-12 → AC3 (chord-drag overlay, snap, disabled/no-layout float, no-zone/Escape unchanged); F-13/F-14/F-15/F-16 → AC4 (config persists, boot reopen, remount render, degraded/empty slot); F-17/F-18 → AC5 (removed hooks absent, kernel unchanged); F-19 → E2E (Mission Monitor); F-20 → RESTART; F-21/F-22/F-23/F-24/F-25 → NFRs (no re-render loop, token-first, keyboard, drag focus, WindowEntry not serialized); F-26 → regression (window-manager); F-27 → CI parity.
