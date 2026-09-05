# window-engine-cleanup — Smoke

Zero-observable-AC spec (pure deletion, verification policy **static**). Live-app smoke is not required for the verdict, but any interactive smoke run must confirm no regression:

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>` (only if a live run is performed).
  - **N/A** — live run not performed; verification policy is **static** (pure deletion slice).
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Cannot find module` (only if a live run is performed).
  - **N/A** — live run not performed; verification policy is **static** (pure deletion slice).
- [x] S-3: `pnpm --filter @fredo/ui build` completes clean — the static equivalent of a smoke gate for this slice.
  - **PASS.** `pnpm --filter @fredo/ui build` → exit **0** ("✓ built in 8.94s", 2570 modules, `tsc && vite build`), no `Cannot find module '@maomaolabs/core'`. `pnpm --filter @fredo/tauri build:webview` → exit **0** (2571 modules).
