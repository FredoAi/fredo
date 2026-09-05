# window-engine-cleanup — Regression

"No-change" baseline for Issue #2810 (Remove `@maomaolabs/core`). The slice is removal-only — nothing must regress.

- [ ] R-1: No visual/rendering change. The removed shim (`fredo-desktop.css`) is comment-only (zero CSS rules) and the own window kernel (`apps/ui/src/shared/window-system/`) already renders window frames. Expected: a clean `pnpm --filter @fredo/ui build` with no CSS output difference attributable to the removal.
- [ ] R-2: No window-kernel or feature-module edits. Expected: `git diff` on `spec/2810` touches only package-manifest/CSS-import/shim/comment/alias files and the lockfile — no edits under `apps/ui/src/shared/window-system/` or any `features/*` module logic.
- [ ] R-3: No re-introduced fallback. Expected: no new code re-introducing feature-level fallback extraction/CSS targeting the removed `@maomaolabs/core` class selectors (`.window-container` / `.window-header` / `.window-controls`).
- [ ] R-4: Tauri app-shell still builds. Expected: the `apps/tauri` `@fredo/ui/styles` import + `vite.config.ts` alias are removed in the same pass as the shim, so no unresolved `@fredo/ui/styles` module remains in the Tauri webview entry.

Overlaps: `window-manager` suite (window framing), `run-cli` suite (launcher/toolbar surface), `mission-monitor` suite (mission panel surface). Run their `regression.md` if the diff touches their surface (expected: no).
