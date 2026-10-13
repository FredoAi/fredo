# app-catalog-cleanup — Exploratory

Unscripted probes. A confirmed finding **promotes** to `functional.md`.

- [ ] E-1: Case/whitespace variants of the removed names — `"QUERY VIEWER"`, `"QueryViewer"`, `"  stepper-probe  "`, `"Stepper  Probe"` — must all remain unknown (no open, no error). Lever: `fredo open-app <identity>` against the running app + companion typed ask.
- [ ] E-2: Ambiguity induction — a query sharing a word with a removed name (`"Viewer"`, `"Probe"`) must not surface a removed app as a candidate and must not become spuriously ambiguous against a surviving app. Lever: companion typed ask path (`useAppOpenRequests.ts`).
- [ ] E-3: Persisted-state probe (non-AC, static/unit pin) — an app-presentation setting or saved workspace layout referencing `query-viewer`/`stepper-probe` must degrade gracefully (empty slot / ignored), never crash or render a blank window (cf. FAQ.md:32 saved-layout empty-slot behavior). Unit pin: `appPresentationStore.test.ts` (unknown-id handling).
- [ ] E-4: Launcher keyboard sweep — after removal, arrow through the whole APPS grid; confirm every highlighted tile maps to a live app (no off-by-one into a removed slot).
- [ ] E-5: `fredo open-app` when the app is not running (non-AC failure path). Lever: stop the app (dev-env Down), then `fredo open-app "stepper-probe"` → documented exit-2 "not running" fallback, not a crash (`app_open.rs:636-640`); unit-pinned by `parse_open_app_result_maps_not_running_to_unavailable`.
