# window-engine-cleanup — Smoke

Zero-observable-AC spec (pure deletion, verification policy **static**). Live-app smoke is not required for the verdict, but any interactive smoke run must confirm no regression:

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>` (only if a live run is performed).
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Cannot find module` (only if a live run is performed).
- [ ] S-3: `pnpm --filter @fredo/ui build` completes clean — the static equivalent of a smoke gate for this slice.
