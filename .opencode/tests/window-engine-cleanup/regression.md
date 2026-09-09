# window-engine-cleanup — Regression

"No-change" baseline for Issue #2810 (Remove `@maomaolabs/core`). The slice is removal-only — nothing must regress.

- [x] R-1: No visual/rendering change. The removed shim (`fredo-desktop.css`) is comment-only (zero CSS rules) and the own window kernel (`apps/ui/src/shared/window-system/`) already renders window frames. Expected: a clean `pnpm --filter @fredo/ui build` with no CSS output difference attributable to the removal.
  - **PASS.** `pnpm --filter @fredo/ui build` clean (exit 0); the removed `fredo-desktop.css` was comment-only (17 lines of comments, no CSS rules), and the own kernel continues to render frame chrome. No visual surface change introduced by the deletion.
- [x] R-2: No window-kernel or feature-module edits. Expected: `git diff` on `spec/2810` touches only package-manifest/CSS-import/shim/comment/alias files and the lockfile — no edits under `apps/ui/src/shared/window-system/` or any `features/*` module logic.
  - **PASS.** `git show 02b91d0 --stat` shows the slice touches only: `apps/{ui,tauri}/package.json`, `apps/{ui,tauri}/src/main.tsx`, `apps/tauri/vite.config.ts`, `apps/ui/src/features/home/fredo-desktop.css` (deleted), `apps/ui/src/shared/window-system/windowTypes.ts`, and `pnpm-lock.yaml`. The `windowTypes.ts` change is a comment-only doc purge (`git show` diff: "mirrors the third-party `@maomaolabs/core` window-engine" → "mirrors the third-party window-engine") — no logic. No `features/*` module logic edited.
- [x] R-3: No re-introduced fallback. Expected: no new code re-introducing feature-level fallback extraction/CSS targeting the removed `@maomaolabs/core` class selectors (`.window-container` / `.window-header` / `.window-controls`).
  - **PASS.** Recursive grep over `apps/ui/` for `@maomaolabs/core` → 0; no fallback CSS/class-selector targeting or fallback extraction path was re-introduced. The slice is deletion-only (2 insertions, 44 deletions across 8 files per `--stat`).
- [x] R-4: Tauri app-shell still builds. Expected: the `apps/tauri` `@fredo/ui/styles` import + `vite.config.ts` alias are removed in the same pass as the shim, so no unresolved `@fredo/ui/styles` module remains in the Tauri webview entry.
  - **PASS.** `pnpm --filter @fredo/tauri build:webview` → exit **0** ("✓ built in 9.03s", 2571 modules); grep `apps/` for `@fredo/ui/styles` → **0** (alias + import removed together, no unresolved module).

Overlaps: `window-manager` suite (window framing), `run-cli` suite (launcher/toolbar surface), `mission-monitor` suite (mission panel surface). Run their `regression.md` if the diff touches their surface (expected: no).
