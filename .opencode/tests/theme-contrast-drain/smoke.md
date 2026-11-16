# theme-contrast-drain — smoke

> App-boots + core-path sanity for Spec #3035. Standard boilerplate, adapted.
>
> **Round 2 (spec/3035 @ 4862f75)** — dev instance cold-started on the tip.

- [x] S-1: App window renders — `#root` populated, non-empty `<body>` (round 2).
- [x] S-2: No console errors — clean. Only 3 pre-existing `[ERROR]` storage lines (`application_data_declare/read/watch failed: … the PostgreSQL pool is not installed yet (fail-closed, R-3.2)`) — environment, not #3035. No `Uncaught` / `Maximum update depth exceeded` after any interaction.
- [x] S-3: Feature surfaces reachable — Settings → **Database** (`settings-postgres-section`), Settings → **Layout** (`layout-new-button`), and the **PostgreSQL app** (`db-connection-form` via Add connection / `db-query-run`) all render.
- [x] S-4: Theme presets switchable — `classic (base — no preset)` (dark, `--accent-primary: rgb(147,51,234)`) and `Light Default` (`#00d1d1`) applied via Appearance without error.
- [x] S-5: Screenshots captured — all round-2 frames saved under `.opencode/tmp/3035/e2e/` and uploaded.
