# window-engine-cleanup — Exploratory

Unscripted probes for the static deletion slice. A confirmed finding **promotes** to `functional.md`.

- [x] E-1: Grep with trailing whitespace / leading `@` variations — a non-exact-string reference (`maomaolabs` or `@maomaolabs/core ` with trailing text) must be surfaced.
  - **CONFIRMED (informational, NOT an AC failure).** Case-insensitive grep `(?i)maomaolabs` over `apps/` surfaced **2** bare-tool-name comments: `apps/ui/src/features/run-cli/RunCliFeature.tsx:17` and `apps/ui/src/features/run-cli/components/RunCliLauncher.tsx:17` ("The maomaolabs Toolbar opens an in-desktop window on item click …"). These reference the retired third-party tool by bare product name — **not** the `@maomaolabs/core` package path — so the AC4 `@maomaolabs/core` grep correctly returns 0 and they do not fail the slice's literals. They are outside the issue's enumerated stale-comment purge scope (MissionMonitorPanel.tsx:707, fredo-desktop.css) and editing them would be re-authoring (out of scope for this removal-only slice). Flagged for the human's awareness.
- [x] E-2: Grep with different case (`@maomaolabs/CORE`) — case-insensitive grep must catch it.
  - **PASS.** Case-insensitive grep `(?i)@maomaolabs/core` over `apps/` (both `apps/ui` + `apps/tauri` source & manifests) → **0**; no differently-cased variation remains.
- [x] E-3: Check `node_modules/.pnpm` for a residual `@maomaolabs/core` directory that `pnpm install` did not prune — run `pnpm install` and re-grep.
  - **PASS.** `Test-Path node_modules/.pnpm/@maomaolabs+core@1.1.0` → **False**; `Test-Path node_modules/@maomaolabs/core` → **False**. The package is not installed and the lockfile is clean (0 `@maomaolabs/core` entries), so no `pnpm install` prune run was required — there is no residual to prune.
- [x] E-4: Verify no other workspace (beyond `apps/ui`, `apps/tauri`) imports `@maomaolabs/core` — a repo-root grep (excluding `node_modules`) proves the frontend is free.
  - **PASS.** Repo-root grep `@maomaolabs/core` → 36 matches, ALL under `docs/agentic-pipeline/` and `.opencode/tests/*` (documentation + persisted test-suite text) — no `apps/` importer. The frontend (`apps/ui` + `apps/tauri`) is free of `@maomaolabs/core`; the only remaining occurrences anywhere are explanatory prose in docs/test suites, not source imports.
