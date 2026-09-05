# window-engine-cleanup — Exploratory

Unscripted probes for the static deletion slice. A confirmed finding **promotes** to `functional.md`.

- [ ] E-1: Grep with trailing whitespace / leading `@` variations — a non-exact-string reference (`maomaolabs` or `@maomaolabs/core ` with trailing text) must be surfaced.
- [ ] E-2: Grep with different case (`@maomaolabs/CORE`) — case-insensitive grep must catch it.
- [ ] E-3: Check `node_modules/.pnpm` for a residual `@maomaolabs/core` directory that `pnpm install` did not prune — run `pnpm install` and re-grep.
- [ ] E-4: Verify no other workspace (beyond `apps/ui`, `apps/tauri`) imports `@maomaolabs/core` — a repo-root grep (excluding `node_modules`) proves the frontend is free.
