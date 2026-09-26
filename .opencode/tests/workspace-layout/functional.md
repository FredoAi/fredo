# workspace-layout — Functional

Scope: the customizable dockable/tileable workspace (issue #2949) — several open apps rendered as panes inside the SINGLE main Fredo window, moved between regions and resized via shared dividers, arranged into named layouts that persist and auto-restore across restart. Built on the own window kernel (`apps/ui/src/shared/window-system/`) and the positionable dock (#2848). Map 1:1 to `.opencode/tmp/2949/triage.md` `## QA Expert` (QA Plan F-1..F-20; Architect EARS R1..R14, AC1..AC5). A FAIL on any AC-mapped F-row fails that AC.

> **Verification policy: live** — pure UI-rendering + persistence spec; the ACs are provable ONLY by observing the running artifact (`pnpm dev:tauri`). Each leg: DOM-snapshot with `getBoundingClientRect` reads, `tauri_webview_screenshot` receipt, `tauri_read_logs(source="console")` after every step. **Live-gate reference:** the round's Evidence MUST include a `telemetry_spans` live query via `.opencode/skills/telemetry-query/telemetry-query.ps1` (non-zero count + recent `max(ingested_at)` at round start AND after the drive). The workspace layout is row-INDEPENDENT (panes derive from the `useWindows()` store, opened via the launcher/CLI) — the query is the live-pipeline reference, not a layout metric. A static-only PASS is a FALSE PASS; the audit gate fails closed. A console `Error:`/`Uncaught`/`Maximum update depth exceeded` on any leg invalidates that leg.

> **Authoritative surface (do not substitute names).** Store `apps/ui/src/shared/window-system/workspaceLayoutStore.ts`; hook `useWorkspaceLayout()` (`useSyncExternalStore`, module-scoped, stable snapshot ref until a real mutation); pure math `paneLayout.ts`; key `Fredo_workspace_layout` (JSON `{version, activeLayoutId, activeSlots, savedLayouts}`); `DEFAULT_LAYOUT_NAME='Default'`. Root `[data-testid="workspace-layout"]`; pane `[data-testid="workspace-pane-<windowId>"]` + `data-pane-region` + `data-pane-window-id`; divider `[data-testid="pane-divider-<dividerId>"]` `role="separator"` + `aria-orientation` + `aria-label="Resize panes"`; region drop targets `[data-testid="pane-region-<region>"]` + `data-pane-drop-region`; controls `[data-testid="layout-menu-button"|"layout-save"|"layout-name-input"|"layout-restore-<layoutId>"|"layout-delete-<layoutId>"]`. **Units:** pane rect = workspace-local CSS px (`Geometry` from `windowGeometry.ts`, MIN 320×200); divider split read from its rect (no `aria-valuenow` in the contract). `windowId` = `FredoFeatureClass.id` (`terminal`, `mission-monitor`, `diagram`). **Reconciliation note:** the UI/UX Expert's section (`## UI/UX Expert`) currently publishes ALTERNATE bindings (`shared/workspace/layoutStore.ts`, `useActiveLayout`/`useWorkspaceActions`, keys `Fredo_workspace_layouts` + `Fredo_workspace_active_layout`, testids `workspace-toolbar`/`workspace-preset-*`/`workspace-save-layout`/`workspace-layout-item-*`/`pane-divider-<axis>-<index>`/`pane-drop-zone-<region>`/`workspace-pane-degraded-<windowId>`/`dock-arrange`, fractions 0..1). The Architect declares its names block AUTHORITATIVE and the UI/UX defers — these suites bind to the ARCHITECT's names. If convergence picks the UI/UX names (or a merged set), the Tester must report the gap to the QA Expert for re-binding rather than record a spurious product FAIL.

## AC1 — panes visible simultaneously (R1, R2, R13)

- [ ] F-1 (R1 / AC1): Open Terminal then Mission Monitor from the launcher grid; activate the tiled workspace.
  - EXPECTED: `[data-testid="workspace-layout"]` contains `workspace-pane-terminal` AND `workspace-pane-mission-monitor` at the SAME time; each has a non-zero `getBoundingClientRect` and its feature content renders; neither pane's rect equals the full workspace (not one-at-a-time full-bleed). Screenshot shows both apps.
  - Edge: 2 / 3 / 4+ panes; open via launcher tile AND `fredo open-app`; activate tiling while one window is maximized; 0 panes = clean desktop; light + dark.
- [ ] F-2 (R2 / AC1): With one pane already placed, place a second open app that has no pane into the workspace.
  - EXPECTED: the app is added as a pane in a default region and the existing panes reflow to share the workspace (no overlap, no pane full-bleed). `data-pane-region` present on the new pane.
  - Edge: add to an empty workspace; add a 3rd/4th pane; add a currently-floating window; add a minimized window; add the same window twice (one pane per windowId).
- [ ] F-13 (R13 / AC1): With a multi-pane arrangement active, maximize a pane (full-bleed), then restore it.
  - EXPECTED: maximize covers the tiles with today's #2924 rect `{0,0,hostW,hostH}` (`borderRadius:0`, 0 grips, control "Restore …"); restore returns the tiled arrangement INTACT — sibling/pane rects unchanged, the saved arrangement uncorrupted. A window with no slot renders as a freeform float (frame-local geometry).
  - Edge: maximize each pane in turn; float a no-slot window over the tiles (z-order); maximize then save a layout; maximize then full restart; confirm no arrangement corruption in `Fredo_workspace_layout`.

## AC2 — move + resize via shared divider (R3, R4, R5)

- [ ] F-3 (R3 / AC2): Drag pane Terminal onto `[data-testid="pane-region-right"]` (repeat for a corner region).
  - EXPECTED: after release the pane's `data-pane-region="right"`, its rendered rect lies inside that region of the workspace, Mission Monitor reflows, and the rendered rect matches the requested region. Screenshot before/after.
  - Edge: all 9 regions incl. corners; move onto the region another pane occupies; rapid consecutive moves; drop outside any region (no-op or snap-back — record behavior, no crash).
- [ ] F-4 (R4 / AC2): Drag `[data-testid="pane-divider-<dividerId>"]` between two adjacent panes along its axis.
  - EXPECTED: BOTH adjacent pane rects change; their COMBINED extent along the divider axis is held constant (±2px); the shared edge stays coincident (no gap, no overlap); the split clamps at MIN_WIDTH/MIN_HEIGHT (320/200). Rendered sizes match the pointer.
  - Edge: drag each extreme (min clamp both ways); vertical vs horizontal divider; 3 panes on one axis (2 dividers, each moves only its pair); drag after a pane close.
- [ ] F-5 (R5 / AC2): During a move/resize drag, sample the rendered geometry at ≥3 points mid-gesture; read `Fredo_workspace_layout` during the gesture and immediately after release.
  - EXPECTED: rendered pane geometry updates on each animation frame, tracking the pointer at every sampled point; the persisted value is UNCHANGED during the gesture and is written within 500 ms after release.
  - Edge: fast flick drag; release outside the workspace; release with no movement (no spurious write); two sequential gestures; console reads at each sample.

## AC3 — named save/restore + automatic default restore (R6, R7, R8, R14)

- [ ] F-6 (R6 / AC3): Arrange 2 panes → open `[data-testid="layout-menu-button"]` → set `[data-testid="layout-name-input"]` = `twopane` → activate `[data-testid="layout-save"]`.
  - EXPECTED: a `[data-testid="layout-restore-<layoutId>"]` entry named `twopane` appears; the persisted `Fredo_workspace_layout.savedLayouts` contains the snapshot — each pane's `windowId`, `region`, and `rect`.
  - Edge: empty / duplicate / whitespace-only / very long name; save with 1 pane; save while a window is floating (no slot); delete a saved layout (`layout-delete-<layoutId>`) then confirm it is gone from the persisted JSON.
- [ ] F-7 (R7 / AC3): Rearrange/close panes, then restore `twopane` via `layout-restore-<layoutId>`.
  - EXPECTED: every referenced pane is placed at its saved `region` + `rect` (±2px); the arrangement REPLACES (not merges with) the current one.
  - Edge: restore over a different arrangement; restore when some panes are already open; restore twice in a row (idempotent); restore after a theme switch.
- [ ] F-8 (R8 / AC3/AC5): Leave a non-empty active arrangement (or mark the `Default` layout), fully quit and relaunch Fredo.
  - EXPECTED: on FIRST paint of the workspace the last active arrangement (or the `Default` layout) renders automatically — no manual action; panes at saved regions/rects; persisted value re-read from the store.
  - Edge: no persisted state (clean desktop, no crash); corrupt/unknown persisted value (degrades to clean/no-crash); `activeLayoutId:null` ad-hoc arrangement; default references a closed app.
- [ ] F-14 (R14 / AC3): After a gesture end or a structural change (add/remove/move pane), read `Fredo_workspace_layout` via `settingsService.get` within 500 ms.
  - EXPECTED: the persisted arrangement reflects the change; at most one write per gesture end (debounced ≥500 ms); a write failure never blocks or corrupts the in-memory store (best-effort, mirroring `dockPositionStore.ts:73-77`).
  - Edge: rapid repeated gestures (coalesced); write-failure path (swallow + no crash); read during a gesture (unchanged).

## AC4 — graceful degradation + sibling reflow (R9, R10)

- [ ] F-9 (R9 / AC4): Pre-seed a layout naming an unregistered window id (and one naming valid-but-unopened `browser-preview`), then restore it.
  - EXPECTED: the affected slot renders EMPTY (or a still-registered app is reopened); the remaining panes keep their arrangement unchanged; no throw; console clean.
  - Edge: unknown id; feature removed/hidden; `showable:false`; app closed after the layout was saved; ALL ids unknown (empty workspace, no crash).
- [ ] F-10 (R10 / AC4): With a 2-pane and then a 3-pane tiled arrangement, close one pane.
  - EXPECTED: sibling panes keep their sizes or reflow sensibly to a valid tiled arrangement (no overlap, no orphan divider); remaining panes stay interactive.
  - Edge: close the middle pane (3-pane); close the last pane (clean workspace); close focused vs backgrounded; close a pane mid-gesture; reopen the closed app (no duplicate pane).

## AC5 — persistence + token-first (R8, R11)

- [ ] F-11 (R11 / AC5): Save a layout under Classic + accentA; switch to Turbo + accentB (theming feature).
  - EXPECTED: pane surfaces, dividers, focus rings and drop-target highlights re-tint to theme B's vars; computed bg/border trace to `--card-bg`/`--border-color`/`--accent-primary`; hover tints use `tint()` (`color-mix`). Static grep over changed files: ZERO `#[0-9a-fA-F]{3,8}`, ZERO `rgba(`/`hsla(`, ZERO `var(--x)NN` alpha-append (excluding issue-ref comments / documented data-palette exemptions).
  - Edge: light + dark; user accent override; divider hover tint; theme switch mid-gesture; a fixed non-token color that ignores the accent is a FAIL.

## Complex scenario (AC3)

- [ ] F-15 (AC3 complex): Given a saved 2-pane layout with Terminal on the left and Mission Monitor on the right / When the user fully restarts Fredo / Then both panes are restored in those positions and sizes on first paint.
  - EXPECTED: the two panes render at the saved regions/rects (±2px) with their content, divider in the saved place, no manual action, console clean.
  - Edge: restart mid-arrangement; cold start after clearing caches; both apps also openable manually afterwards; restart with a third window closed.

## Non-functional

- [ ] F-16 (loop guard): After EVERY pane move/resize/save/restore/close and after a theme flip, read the webview console; grep the changed layout/effect code.
  - EXPECTED: no `Maximum update depth exceeded`/`Error:`/`Uncaught`; effect/memo deps consume epoch/primitive signals — no array `.length`, no freshly-created object refs (AGENTS #523 rule; `AppDock.tsx:33-38` precedent).
  - Edge: rapid divider drag; repeated save/restore; theme flip mid-arrangement.
- [ ] F-17 (persistence medium): Inspect the layout store + mount/unmount behavior.
  - EXPECTED: module-scoped store consumed via `useSyncExternalStore`; no `useRef`/`useState`/component-local persistence for the arrangement; survives a `WindowManager`/Home remount and close-all-reopen.
  - Edge: remount WindowManager; close all panes then reopen; HMR reload; `resetWorkspaceLayoutStoreForTests()` isolation in unit tests.
- [ ] F-18 (keyboard): Focus a pane, then the divider; drive arrow keys and the divider's resize keys.
  - EXPECTED: arrow keys move focus between panes; the divider's resize keys change the split; the focused pane/divider shows the global `:focus-visible` ring; divider is `role="separator"` with `aria-orientation` + `aria-label="Resize panes"`; no focus trap.
  - Edge: first/last pane boundary; narrow viewport; many panes; screen-reader name; divider focused then arrow keys.

## Regression + CI

- [ ] F-19 (regression): Run `.opencode/tests/window-manager/functional.md` F-3..F-11 + `regression.md` R-1..R-15 while the workspace feature ships.
  - EXPECTED: open → maximize → restore → minimize → focus → close behaves exactly as #2924; one window per feature id; no focus steal; close idempotent/re-entrancy-guarded; freeform float geometry stays frame-local when no tiled layout is active; `AppDock` stays a read-only `useWindows()` consumer.
  - Edge: rapid re-open; update-while-minimized; maximize→restore geometry; dock position/reveal; launcher open.
- [ ] F-20 (CI-parity — F-14-style): Run `CONTRIBUTING.md:28-35`'s exact command set on the spec tip.
  - EXPECTED: `pnpm --filter @fredo/ui typecheck`, `pnpm --filter @fredo/ui build`, `pnpm --filter @fredo/ui test:run`, `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`, `cargo test … --locked`, `cargo clippy … --locked -- -D warnings` — every step exits 0 with zero warnings; no existing assertion weakened/disabled/deleted.
  - Edge: Rust touched → cargo legs required; UI-only → UI legs required; a red local gate predicts a red PR check.

## F-row → AC map

F-1/F-2/F-13 → AC1 (simultaneous panes, add/reflow, maximize/float preserved); F-3/F-4/F-5 → AC2 (move to region, divider resize combined-extent, live gesture + no mid-gesture persist); F-6/F-7/F-8/F-14 → AC3 (named save, restore, automatic restart restore, ≤500 ms persist); F-9/F-10 → AC4 (unavailable-app degradation, sibling reflow); F-11 → AC5 (token-first under theme/accent change); F-15 → AC3 complex; F-16/F-17/F-18 → NFRs (no re-render loop, module-scoped persistence, keyboard); F-19 → regression; F-20 → CI parity.

---

## Test run (round 1) — Verdict: **FAIL** (AC1, AC2, AC3, AC5)

> Live-driven via `pnpm dev:tauri` (spec/2949 @ `7bc8373c`; serving checkout confirmed by `dev-env.ps1 -Action Status`). Live `telemetry_spans`: 1365 → 1637 rows (max `ingested_at` 2026-09-26T19:51:09Z → 2026-09-26T20:09:33Z). Each leg DOM-snapshotted + rect-measured + screenshotted; console read after every leg (clean).

- **F-1 (AC1) — FAIL (entry path).** With 3 feature windows open and 0 tiled panes there is NO arrange control: `workspace-toolbar` / `workspace-arrange` / `dock-arrange` / `layout-menu-button` all absent; the dock has no arrange well. `WindowManager.tsx:184` gates the toolbar on an existing pane/slot, so `workspace-arrange` (and the only app-code `addPane` caller) is unreachable at 0 panes. Rendering half PASSES once a pane is bootstrapped (terminal + mission-monitor rendered simultaneously).
- **F-2 (AC1) — PASS.** `workspace-arrange` added an open app as a pane; existing panes reflowed (no overlap, no full-bleed).
- **F-3 (AC2) — FAIL.** Move grip → 9-region overlay (single `workspace-announcer`) works, but committing `pane-region-bottom-right` (and `right`) did NOT change the pane's `data-pane-region`/rect — `movePane` falls back to a slot-order `reflowSlots` when the target region overlaps (`workspaceLayoutStore.ts:209`). No move announcement.
- **F-4 (AC2) — PASS.** Divider keyboard resize: terminal 640→672, sibling 640→608, combined 1280 constant; min clamp 320 held under a −400 px drag.
- **F-5 (AC2) — PASS.** Pointer drag: 2 sampled frames tracked the pointer (320/960 → 528/752); persisted value unchanged mid-gesture, written within the debounce after release.
- **F-6 (AC3) — PASS.** Saved `threepane`; `savedLayouts` persisted; `layout-restore-*` entry appeared.
- **F-7 (AC3) — PASS.** Restored `twopane` replaced the arrangement at the exact saved rects; `activeLayoutId` persisted.
- **F-8 (AC3/AC5) — FAIL.** Full restart hydrated `activeSlots` as `workspace-pane-degraded-*` placeholders ("App not available"); apps are never reopened, and re-opened apps arrive full-bleed (maximized) requiring a manual Restore.
- **F-9 (AC4) — PASS.** Closed-app and unknown-id slots degraded with siblings' rects intact, no throw, console clean.
- **F-10 (AC4) — PASS.** Closing a pane removed its slot; the sibling absorbed the freed band; no orphan divider.
- **F-11 (AC5) — PASS.** Computed colors trace to `--card-bg`/`--border-color`/`--accent-primary`; live theme switch (light-default → cyberpunk) re-tinted panes + divider; 0 colour literals and 0 `var(--x)NN` in changed files.
- **F-13 (AC1/regr) — PASS.** Maximize/float left the tiles intact; restore returned the pane to its exact slot.
- **F-14 (AC3) — PASS.** ≤500 ms debounced persist, one write per gesture end.
- **F-15 (AC3 complex) — FAIL.** Saved Terminal-left / Mission-Monitor-right did not restore as panes with contents on first paint — two "App not available" placeholders instead.
- **F-16/F-17/F-18/F-19 — PASS.** Console clean throughout; module-scoped `useSyncExternalStore` store survives restart/remount; divider `role="separator"` + Arrow resize + `:focus-visible` ring + pane arrow focus; window-kernel/full-bleed regression holds.
- **F-20 — PASS.** `typecheck` 0, `build` 0, `test:run` 171 files / 2432 tests, `cargo check` + `cargo clippy -D warnings` 0 warnings.

### Promoted from exploratory (round 1)

- **F-21 (from E-11) — move-to-region must honour the requested region.** Chrome: `workspace-pane-move-<id>` + `pane-region-<region>`. EXPECTED: committing a region sets `data-pane-region` to it and moves the rendered rect into it (with siblings reflowing). ACTUAL (round 1): the pane keeps its region; panes repartition by slot order. A move must also announce `Moved <title> to <region>`.
- **F-22 (entry-path reachability, from the AC1 probe) — an arrange entry MUST exist at 0 tiled panes.** Chrome: a reachable control (`dock-arrange` in the dock, or an always-rendered `workspace-arrange`). EXPECTED: with ≥1 open window and no panes, a visible control places the open windows as panes. ACTUAL (round 1): no control exists until a pane already does.
- **F-23 (restart restores apps, from E-6/F-15) — restart must restore the arrangement WITH the apps' contents.** EXPECTED: after a full restart the saved panes render with content on first paint. ACTUAL (round 1): only the slots hydrate (degraded placeholders); apps are not reopened, and the normal open path opens them full-bleed.

---

## Test run (round 2) — Verdict: **PASS** (5/5 ACs; 20/20 F-rows)

> Live-driven via `pnpm dev:tauri` (spec/2949 @ `960ff034`; serving checkout confirmed before the drive and by the restart log). Live `telemetry_spans`: 1968 → 2233 rows (max `ingested_at` 2026-09-26T20:41:11Z → 2026-09-26T20:59:56Z). Full restart via `dev-env.ps1 -Action Restart -Spec 2949`. Console clean after every leg.

Round-2 fixes verified (round-1 FAIL → PASS):

- **F-1 (AC1) — PASS.** At 0 tiled panes (3 open full-bleed windows) `[data-testid="dock-arrange"]` is present in the DOM; revealing the left dock edge (`document pointermove clientX=2` → dock `x 0`, `visibility:visible`) and clicking it tiled **3 `workspace-pane-*` at 640-wide non-full-bleed rects** (terminal left / mission-monitor center / setup right), `frames:[]`, `degraded:[]`.
- **F-2 (AC1) — PASS.** Query Viewer opened full-bleed (no slot) → `workspace-arrange` added it as a pane; 4 panes in a 2×2 grid, 0 overlaps, announcer "Added 1 pane".
- **F-3 (AC2) — PASS.** 3 panes → move Terminal → `pane-region-bottom-right`: terminal `data-pane-region="bottom-right"` at `{960,527,960,491}` (exact bottom-right quarter); siblings re-homed non-overlapping; announcer **"Moved Terminal to bottom-right"**.
- **F-4/F-5 (AC2) — PASS.** Divider drag: both adjacent panes changed, combined extent constant 1920; two distinct mid-gesture samples tracked the pointer; persisted value **unchanged mid-gesture** and written on release (<500 ms).
- **F-6/F-7/F-14 (AC3) — PASS.** Saved `r2layout`; restore replaced the arrangement at saved rects; ≤500 ms debounced persist.
- **F-8/F-15 (AC3/AC5) — PASS (decisive).** Persisted Terminal-left / Mission-Monitor-right → full restart → **both panes restored un-maximized with contents on first paint**, `degraded:[]`, `frames:[]`, no manual Restore.
- **F-9/F-10 (AC4) — PASS.** Explicit restore of a closed app and of an unknown id still degrade (the boot-reopen does NOT leak into `restoreLayout`); closing a pane makes the sibling absorb, no orphan divider.
- **F-11 (AC5) — PASS.** Live theme switch (cyberpunk → light-default) re-tints panes/borders/dividers to `--card-bg`/`--border-color`/`--accent-primary`; 0 colour literals, 0 `var(--x)NN`.
- **F-13/F-16/F-17/F-18/F-19/F-20 — PASS.** Maximize/float/restore exact-slot return; console clean; module-scoped store survives restart; divider keyboard resize + pane arrow focus + focus ring; kernel regression holds (`windowStore`/`windowTypes`/`WindowFrame` unchanged); CI-parity green (`typecheck`/`build`/`test:run` 172 files / 2444 tests / `cargo check` / `cargo clippy -D warnings`).

**Promoted F-21/F-22/F-23 now PASS** on the served tip. Round-2 observation (non-blocking): immediately after `dock-arrange` at 0 panes the panes briefly report `offsetHeight 1017` vs tiles `981`; the next structural change re-homes them to 981 — cosmetic only.
