# Window Manager — Functional Test Cases (Spec #2807 — Own OS-style window-system kernel)

> Durable functional suite (feature domain `window-manager`). One `- [ ]` case per requirement; observable expected outcome per case. Each case carries the QA-Plan row number (T-R1..T-R4) and its Acceptance Criterion (AC1..AC4) so the tester's `## Tests Runs` verdict maps a row to an AC — a FAIL on any row fails that AC.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result via `.opencode/skills/telemetry-query/telemetry-query.ps1`) for this frontend rendering/UX feature. A static-only PASS is a FALSE PASS.
>
> Live-drive doctrine (G-035): drive via `pnpm dev:tauri`; capture `tauri_webview_dom_snapshot` + `tauri_webview_screenshot` at each interaction step; read `tauri_read_logs(source="console")` after every step; reference the RUNNING surface (not just a DOM grab) with a live telemetry query confirming the classifier/row pipeline still flows while the engine is swapped. Never assert a capture that misrepresents the selected window — confirm the target via DOM before capture.

## AC1 — Own window engine (T-R1, R-1 / R-2)

- [ ] F-1 (T-R1 / AC1): Grep the window-engine path (`Home.tsx` and the owned window-system source under `apps/ui/src/shared/window-system/`) for the three engine symbols — `WindowSystemProvider`, `WindowManager`, `useWindowActions` — imported from `@maomaolabs/core`.
  - EXPECTED: zero matches importing those three symbols from the third-party package; `WindowSystemProvider`, `WindowManager`, and `useWindowActions` are declared and exported from an owned `apps/ui/src` module (the window-engine path of `Home.tsx` carries no `@maomaolabs/core` import).
  - Edge: a match in a comment or type-only position is STILL recorded as a FAIL for AC1 (own-code requirement) — flag it, do not dismiss it. Only the plan-permitted non-window remnants may remain.
- [ ] F-2 (T-R1 / AC1): Confirm the owned window-actions hook surface is present and exports the four operations (`openWindow`, `closeWindow`, `updateWindow`, `focusWindow`) plus an owned `useWindows` open-window list hook, both delivered from a shared `apps/ui/src` module.
  - EXPECTED: the owned module exposes those hooks with a drop-in signature so feature callers need only an import-source swap; no caller re-implements the engine.
  - Edge: any caller still importing the engine hooks from `@maomaolabs/core` is a FAIL for AC1 — re-pointing must be complete.

## AC2 — Window lifecycle, end-to-end (T-R2, R-3 / R-4 / R-5 / R-6)

> Drive in the running app. Open a feature window from the toolbar; capture DOM + screenshot at each step.

- [ ] F-3 (T-R2 / AC2): From the desktop toolbar, click the launcher entry for a registered grid feature (e.g. Mission Monitor) to open its window.
  - EXPECTED: the feature window opens rendering its `title`/`icon` and declared `canClose`/`canMaximize`/`canMinimize`/`isMaximized` state, framed in the Fredo brand chrome (not the third-party chrome). DOM snapshot shows the window surface + header; screenshot confirms the brand chrome.
  - Edge: a feature `openSelf()`-driven window opens the same way; the open dispatch is identical regardless of launcher.
- [ ] F-4 (T-R2 / AC2): With the feature window open, drive an update/re-render TWICE (trigger a state change so the feature re-renders its content).
  - EXPECTED: content updates on each re-render with no remount / no loss of prior content; the second update further mutates the same window (re-open + update twice works end-to-end). DOM snapshot shows the freshly rendered content both times.
  - Edge: update twice while focused does NOT reset the window size/position; the render is a spread-merge patch, never a full replacement.
- [ ] F-5 (T-R2 / AC2): Minimize the window (minimize control), confirm it hides, then restore it (focus/programmatic restore).
  - EXPECTED: minimize hides the window from the workspace and moves focus to the next visible window; restore brings the SAME window back with identity + content intact. DOM snapshot before/after.
  - Edge: an update while minimized does NOT silently restore or steal focus — the window stays minimized until an explicit restore/focus.
- [ ] F-6 (T-R2 / AC2): Maximize, then restore, the window.
  - EXPECTED: maximize goes full-bleed (radius 0, no drag/resize, control flips to "restore"); restore returns to the prior float geometry with content + identity intact. DOM snapshot at maximized and restored states.
  - Edge: maximize while already maximized toggles to restore; double-click header toggles maximize/restore; maximize then minimize then restore preserves state.
- [ ] F-7 (T-R2 / AC2): Focus / z-order — open a second window, then focus the first again (click it or drive focus).
  - EXPECTED: focused window comes to the top of the z-order (accent border + halo) and the previously-top window drops to unfocused (neutral border + muted title). DOM snapshot shows the topmost change.
  - Edge: `focusWindow` is the programmatic path; any window behind drops to unfocused; the content of the receding window stays fully readable.
- [ ] F-8 (T-R2 / AC2): Close the feature window via the chrome close control.
  - EXPECTED: the window is removed and the feature's registered close callback runs (`onUnmount` + registry removal) before the entry is dropped; close is idempotent and re-entrancy-guarded (no loop, no crash). After close the window is gone from the open-window list and focus moves to the next topmost window (or the workspace).
  - Edge: close of a focused vs a backgrounded window both succeed; closing the only window leaves a clean workspace with no stray frame.
- [ ] F-9 (T-R2 / AC2, edge — rapid double-open): Trigger two opens of the same feature id in quick succession.
  - EXPECTED: exactly ONE window exists for that feature id (no duplicate window, no duplicate frame); the second open re-focuses / no-ops rather than stacking a duplicate.
  - Edge: three rapid opens still yield one window; zero console errors during the burst.
- [ ] F-10 (T-R2 / AC2, edge — backdrop/drag boundaries): Drag the window by its header and resize by a grip.
  - EXPECTED: dragging translates the window but the title bar stays within the workspace top; resizing enforces a min width/height and only the correct grip resizes the correct edge; the control cluster and grips stop propagation so a pointerdown on a control does not start a drag.
  - Edge: a pointerdown on the 28px control cluster does NOT start a drag; a drag that would push the title bar off the top is clamped; resize grip cursors are correct per direction.
- [ ] F-11 (T-R2 / AC2, console hygiene): After the full lifecycle (open → update x2 → min → restore → max → restore → focus → close), read the webview JS console.
  - EXPECTED: no `Error:` / `Uncaught` / `Maximum update depth exceeded` / re-render-loop symptom at any step. A console error invalidates the leg's evidence even if the visual assertion renders.

## AC3 — Token-native chrome (T-R3, R-7)

- [ ] F-12 (T-R3 / AC3): Grep the NEW window chrome components (header, title, icon, min/max/close controls, drag grip, resize grip, float) for hardcoded hex/rgba and for shared `tint()` usage.
  - EXPECTED: zero hardcoded hex/rgba (allowing `transparent`, `inherit`, `currentColor`, `none` and the documented data/art-palette exemptions); every surfaced color references a theme CSS var (`var(--card-bg)`, `var(--border-color)`, `var(--accent-primary)`, `var(--status-*)`, `--body-bg`, `--header-bg`); hover/active mixed tints use the shared `tint()` helper (`color-mix`).
  - Edge: `var(--accent-primary)22` (alpha-append onto a `var()`) is an invalid-CSS FAIL; a hex embedded in an rgba fallback is a FAIL unless it is an exempt data/art palette; no Chrome surface branches on light/dark — only the CSS vars the theme swaps.
- [ ] F-13 (T-R3 / AC3, live render): In the running app, visually verify the chrome in BOTH light and dark theme (toggle via the theming feature) and under a user-accent override.
  - EXPECTED: the chrome re-tints from the theme tokens with no hardcoded color; hover tints respond to the accent/theme override; focused vs unfocused (top vs behind) frame states are distinguishable; the frame renders acceptably in both themes.
  - Edge: a fixed non-token color that ignores the user accent is a defect (FAIL); close control renders its destructive affordance via a hover tint, NOT via `variant="outline" colorPalette="red"` (the known #431 pitfall).

## AC4 — WINDOW_STYLES removal + graceful degradation (T-R4, R-8 / R-9)

- [ ] F-14 (T-R4 / AC4): Grep for the chrome-variant machinery — `WINDOW_STYLES` variants (`WindowStyleContext.tsx`) and `WindowStyleSelector` — in the chrome path, and confirm no dangling import/export breaks the build.
  - EXPECTED: no `WINDOW_STYLES` variant map and no `WindowStyleSelector` remain in the chrome path; the chrome is the single brand chrome; the provider accepts no `systemStyle` prop; no dangling import/export of the removed style types remains in `index.ts`/`features/home/index.ts` or the settings/theming surfaces (the build stays green).
  - Edge: any leftover reference to the removed style variant type or selector that breaks `pnpm --filter @fredo/ui build` is a FAIL — grep AND a clean build are both required.
- [ ] F-15 (T-R4 / AC4, graceful degradation): Pre-seed a persisted legacy `windowStyle` value in the browser/local store (key `Fredo_window_style`), then reload the app, and observe the chrome.
  - EXPECTED: the desktop renders the SINGLE brand chrome (no variant chrome), default chrome, nothing crashes, and the settings UI no longer exposes any style variant. Console + system logs show no error.
  - Edge: a stale legacy value (`default` / `traffic` / `linux` / `yk2000` / `aero`) renders brand chrome, never diverges, never throws; a null/absent/unknown (bogus) value also renders brand chrome without throwing; the provider never reads `windowStyle` to pick chrome.

## Non-functional

- [ ] N-1 (token/variable usage): Visual + grep check across the chrome surfaces — all colors come from theme semantic tokens → CSS vars; tints via the shared `tint()` helper; never hardcode hex/rgba; never alpha-append onto a `var()` reference.
  - EXPECTED: the token→var→theme color flow is intact; no raw color value leaks into the chrome.
  - Regression risk: a one-off inline color in a chrome component that ignores the user theme is a FAIL.
- [ ] N-2 (no cross-feature import): The own window-manager kernel (provider, manager, hooks, window model, chrome) lives in a shared module; features import from shared, never from another feature.
  - EXPECTED: code inspection confirms the kernel has no import from another `features/*` module; `Home.tsx` and the three feature callers import only the shared hooks.
  - Regression risk: a kernel importing from a feature is a FAIL.
- [ ] N-3 (Chakra UI v3 only): The chrome uses Chakra v3 props only.
  - EXPECTED: `disabled` not `isDisabled`, `loading` not `isLoading`, `colorPalette` not `colorScheme`; compound components (`Tabs.Root`, `Dialog.Root`) where used; brand chrome uses Chakra semantic tokens, never raw values.
  - Regression risk: a v2 `is*`/`colorScheme` prop reintroduced is a FAIL.
- [ ] N-4 (accessibility / UX): Window controls are keyboard-focusable with aria-labels naming action + window (e.g. "Minimize Mission Monitor", "Close Mission Monitor"); the frame is a non-modal group with the window title as its accessible name; min/max/close are real tabbable buttons with 28px hit targets; focus moves to the next topmost window's header on close/minimize, and to the toggled control on maximize/restore.
  - EXPECTED: DOM/a11y snapshot shows the group semantic + labeled reachable controls; keyboard `CmdOrCtrl+W` (close), `CmdOrCtrl+M` (minimize), `CmdOrCtrl+Shift+M` (maximize/restore), `Ctrl+Tab` (focus next window) behave as specified; minimized/behind windows are excluded from tab order.
  - Edge: restore mirrors `aria-expanded` like maximize; a minimized window is hidden from the a11y tree; `:focus-visible` outline uses the accent token.
- [ ] N-5 (clean build): `pnpm --filter @fredo/ui build` completes with no TS errors; no dangling `WINDOW_STYLES`/`WindowStyleSelector` import left behind.
  - EXPECTED: build is green end-to-end; zero warnings. If the Rust side is touched, `cargo check`/`cargo clippy -D warnings` from `apps/tauri/src-tauri` is clean.
  - Regression risk: a type/export error from a stale window-style import is a FAIL (AC4).
- [ ] N-6 (no re-render loop): After every window interaction, read the webview JS console.
  - EXPECTED: no `Maximum update depth exceeded` / re-render-loop symptom; window-store updates are epoch-based (advance only on real mutation), never driven by array `.length` or newly-created object refs in a `useEffect`/`useMemo` dependency.
  - Regression risk (#523): an effect depending on array `.length` or object identity is a FAIL.
