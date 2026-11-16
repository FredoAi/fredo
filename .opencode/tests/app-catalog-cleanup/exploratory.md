# app-catalog-cleanup — Exploratory

Unscripted probes. A confirmed finding **promotes** to `functional.md`.

- [x] E-1: Case/whitespace variants of the removed names — `"QUERY VIEWER"`, `"QueryViewer"`, `"  stepper-probe  "`, `"Stepper  Probe"` — must all remain unknown (no open, no error). Lever: `fredo open-app <identity>` against the running app + companion typed ask.
- [x] E-2: Ambiguity induction — a query sharing a word with a removed name (`"Viewer"`, `"Probe"`) must not surface a removed app as a candidate and must not become spuriously ambiguous against a surviving app. Lever: companion typed ask path (`useAppOpenRequests.ts`).
- [x] E-3: Persisted-state probe (non-AC, static/unit pin) — an app-presentation setting or saved workspace layout referencing `query-viewer`/`stepper-probe` must degrade gracefully (empty slot / ignored), never crash or render a blank window (cf. FAQ.md:32 saved-layout empty-slot behavior). Unit pin: `appPresentationStore.test.ts` (unknown-id handling).
- [x] E-4: Launcher keyboard sweep — after removal, arrow through the whole APPS grid; confirm every highlighted tile maps to a live app (no off-by-one into a removed slot).
- [ ] E-5: `fredo open-app` when the app is not running (non-AC failure path). Lever: stop the app (dev-env Down), then `fredo open-app "stepper-probe"` → documented exit-2 "not running" fallback, not a crash (`app_open.rs:636-640`); unit-pinned by `parse_open_app_result_maps_not_running_to_unavailable`.

## Results (run 2026-10-13, spec/3055 @ 5bb52bf)

- **E-1 PASS** — `QUERY VIEWER`, `QueryViewer`, `stepper-probe` (and `Query Viewer`, `Stepper Probe`) all → `{"outcome":"unknown"}` exit 1. Whitespace variant `  stepper-probe  ` trimmed to `stepper-probe` → unknown (the CLI positional preserves inner spacing; resolver trims via `normalizeAppQuery`).
- **E-2 PASS** — partials `Viewer` and `Probe` → `{"outcome":"unknown"}` exit 1, no candidate surfaced, no spurious ambiguity.
- **E-3 PASS** (static/unit) — `appPresentationStore.test.ts` unknown-id handling green in the 2689-test UI suite; `appPresentationStore` normalization retained (AC4).
- **E-4 PASS** — arrow-nav selection is always one of the 5 real tiles (`PostgreSQL`/`Terminal`), never a removed slot; filtered-to-empty queries render the graceful "No apps available" state, not a ghost tile.
- **E-5 NOT RUN** — requires stopping the dev instance (dev-env Down), which would invalidate the live AC1/AC5 environment for this round. The exit-2 mapping is unit-pinned (`parse_open_app_result_maps_not_running_to_unavailable`, green in `cargo test --lib`). Non-AC exploratory.
