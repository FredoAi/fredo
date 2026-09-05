# Launcher — Functional

> Live-plan suite for the OS-style launcher shell (issue #2808). Cases map 1:1 to the QA
> Plan in `.opencode/tmp/2808/triage.md` `## QA Expert`. Execute on a **running** Fredo
> desktop app with the spec branch. Mock `fredo emit` events are NOT required — this is a
> pure UI shell; the shell ACs are verified by DOM snapshot + screenshot + keyboard/interaction.
>
> Evidence per case: `tauri_webview_dom_snapshot`, `tauri_webview_screenshot`,
> `tauri_webview_interact`, `tauri_webview_keyboard`, `tauri_read_logs(source="console")`.

## F-1 — Own shell, no @maomaolabs/core in the launcher chrome (AC1)
- [ ] F-1: Grep the launcher chrome source under `apps/ui/src/features/home/components/` for `@maomaolabs/core` and for the `useWindows` import source. **Expected:** zero `@maomaolabs/core` imports in the chrome; the chrome lives under `apps/ui/src`; `useWindows` imports from `shared/window-system/useWindows` (own kernel).
- [ ] F-1 edge: The own-kernel `useWindows` import is ALLOWED (do not flag). `@maomaolabs/core` may remain in unrelated non-launcher files (Issue 4 scope) — do not fail the plan for them.

## F-2 — Real SHOWABLE_FEATURES grid (AC2a)
- [ ] F-2: Open the launcher; `tauri_webview_dom_snapshot(type="structure")` the grid. **Expected:** the rendered tile set equals `SHOWABLE_FEATURES.map(f => f.name)` (from `apps/ui/src/features/home/components/Home.tsx:22`); every showable feature appears as a tile; non-showable features are absent.

## F-3 — Tile select opens the feature through the own kernel (AC2b)
- [ ] F-3: Focus the grid, arrow to a tile, press Enter. **Expected:** the feature window opens (WindowFrame + feature title + content appears in the DOM snapshot); it is focused; `useWindows()` gains the entry. The open routes through `onOpenFeature(id, feature)` → own-kernel `openWindow`.
- [ ] F-3 edge: Opening an already-open tile re-focuses (no duplicate) per `windowStore.ts:68-91`; multi-window features get a suffixed id.

## F-4 — Structural match to desktop.png (AC3)
- [ ] F-4: Open the launcher; capture a screenshot; compare to `.opencode/wireframes/desktop.png` in light and dark. **Expected:** FREDO header notch, pixel-butler avatar, `>` search-or-command bar, app grid, keyboard-nav hints, online clock, selected-tile cyan border, scrollbar — all present and positioned per the wireframe.

## F-5 — Empty SHOWABLE_FEATURES (AC4)
- [ ] F-5: Force `SHOWABLE_FEATURES` empty (dev stub / empty registry). Open the launcher. **Expected:** no crash; shell renders a graceful empty state (notch + avatar + command bar intact); grid shows an empty-state message or no tiles; console has no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] F-5 edge: Keyboard-nav (arrows) + Enter on the empty grid opens nothing; `useWindows()` gains no entry.

## F-6 — Theming token-native (AC5)
- [ ] F-6: Grep the launcher chrome + styles for hardcoded hex/`rgba(`/`rgb(`. **Expected:** zero hardcoded color literals (documented exemptions allowed); colors via `var(--...)` theme tokens; hover via `tint('var(--accent-primary)', N)`; light + dark both render acceptably; no alpha-append onto `var()`.
