# Functional — app-window-presentation

> Feature #2955. Per-app choice: an app opens **inside the main Fredo window** (`same-window`)
> or in **its own separate OS window** (`new-window`). The choice is stored per app and honored
> from every entry point. Generalizes the #2947 Terminal contract
> (`.opencode/tests/terminal-presentation-mode/`) — that suite's Terminal-only rows are inherited,
> not duplicated.
>
> **Binding names (G-187):**
> - Storage unit: AppStore control-plane KV key `app_window_presentation`, a JSON map
>   `{ "<appId>": "same-window" | "new-window" }` (raw string; empty/absent = `{}`). Legacy
>   fallback key `terminal_presentation_mode` (raw `same-window` | `new-window`).
> - Default for absent/unrecognized: `same-window` (main window) for EVERY app, including Terminal.
> - Display units: Settings nav item **"Apps"** (`settings-nav-apps`); section root
>   `app-presentation-settings`; per-app row `app-presentation-row-<appId>`; radio inputs
>   `app-presentation-mode-<appId>-same-window` (**"Main window"**) and
>   `app-presentation-mode-<appId>-new-window` (**"Own window"**); factory disabled note
>   `app-presentation-multi-window-note-<appId>`; pre-hydration skeleton `app-presentation-loading`;
>   live-session confirm/cancel `app-presentation-change-confirm` / `app-presentation-change-cancel`;
>   ONE `role="status"` region `app-presentation-status`.
> - Standalone window: generic route `index.html?view=app&id=<appId>`, labels `terminal` / `doom` /
>   `app-<appId>`, root testid `app-window-root`, unknown fallback `app-window-unknown`.
>
> **Verification policy: live** — every case is driven in the RUNNING app and a PASS must carry a
> live `telemetry_spans` receipt (non-zero + recent `max(ingested_at)`). A static-only PASS is a
> FALSE PASS. Live lever: managed `psql` (database `postgres`, URI from `pg_supervisor_status`,
> password from the OS keychain) via the allowlisted
> `run-exitcode.ps1 -Command` wrapper; fall back to the app-pool-backed `telemetry_get_stats` when
> the pool is saturated (disclose the substitution). Spans come from a live OTLP-ingested app
> action — the CLI `fredo emit` path writes rows, not spans (G-256).
>
> Each case states an observable expected outcome. On pass keep the checkbox and append evidence;
> on fail leave `- [ ]` and mark FAIL with expected-vs-actual + repro.

## Cases

- [ ] **F-1 (R-1 / AC1) — the Apps section lists every eligible app and persists a per-app choice across a full restart.**
  Open Settings and select the nav item `settings-nav-apps`. Confirm the section root
  `app-presentation-settings` and a `app-presentation-row-<appId>` for each named eligible app
  (Terminal `terminal`, Doom `doom`, Mission Monitor, Settings); confirm the factory app Query Viewer
  renders `app-presentation-multi-window-note-query-viewer` with its `-new-window` radio `disabled`.
  Select `app-presentation-mode-terminal-new-window`; read `app-presentation-status`; read the store
  via `get_control_setting{key:"app_window_presentation"}`; perform a FULL app restart; reopen Settings → Apps.
  **Expected:** the named rows are covered (assert COVERAGE of named elements, never a literal count —
  G-271); the choice writes immediately (`{"terminal":"new-window"}`, no Save footer) and shows a
  `app-presentation-status` confirmation; after the restart the Terminal `-new-window` radio is
  `aria-checked="true"` and the store still holds the value. A pre-hydration `app-presentation-loading`
  skeleton renders before the stored value resolves (no flash of a wrong pre-selection).
  **Data:** `clean-fredo-db.ps1` for a fresh profile; `tauri_webview_execute_js` `get_control_setting` read-back.
  **Edge:** keyboard-only radio operation; factory `-new-window` disabled; no re-render loop.

- [ ] **F-2 (R-2 / AC2) — default opens in the main window; a stored `new-window` app opens in its own OS window.**
  Fresh store (no map / `{}`): open Terminal from the launcher grid; inspect the main webview DOM and
  `tauri_manage_window(action="list")`. Then set `terminal`=`new-window` and re-open. Repeat for a
  generic app (Mission Monitor).
  **Expected:** the default opens INSIDE the main Fredo window (in-window kernel id `terminal`; the
  window list has NO native `terminal`). Stored `new-window` opens a separate OS window — bespoke apps
  labelled `terminal`/`doom` (`index.html?view=terminal`), generic apps labelled `app-<appId>` at
  `index.html?view=app&id=<appId>` with `app-window-root` present in the standalone webview.
  **Edge:** absent value → default (F-4); unknown generic id → `app-window-unknown`; factory app stays
  in-window even if the map holds `new-window`.

- [ ] **F-3 (R-3 / AC3) — separate windows are singletons per app; re-open focuses, never duplicates.**
  With `terminal`=`new-window`, open Terminal; list windows and count `terminal`-labelled entries;
  re-invoke the SAME entry point (launcher, then again via `fredo open-app`). Repeat with a generic
  `new-window` app (`app-<id>`).
  **Expected:** exactly ONE native window exists for the app; the second open brings the EXISTING
  window to the front (focused) and creates NO second (`tauri_manage_window list` shows one, focused).
  **Edge:** rapid double-open; two different entry points in sequence; re-open while already focused.

- [ ] **F-4 (R-4 / AC4) — absent/unrecognized values fall back to the default; a mode change leaves no orphan or duplicate.**
  (a) Seed the store with an absent map, `"not-json"`, `{}`, and `{"terminal":"bogus"}`; separately
  seed legacy `terminal_presentation_mode`=`"same-window"` / `"new-window"` with the map absent;
  restart and open the app each time. (b) With an app open in-window, change its mode to Own window
  then back.
  **Expected:** absent/unrecognized resolves to the defined default `same-window` (opens in the main
  window; no failure, no blank). A valid legacy `terminal_presentation_mode` is copied into
  `map.terminal` on first hydrate AND the backend falls back to it before the first hydrate, so
  Terminal routes by the legacy value. On mode change the superseded host is closed
  (`closeWindow(id)` and/or `close_app_window(id)`), leaving no orphaned or duplicate window.
  **Data:** `save_control_setting` seeding (canonical map + legacy key, control plane);
  `get_control_setting` read-back; restart.
  **Edge:** `"not-a-mode"` / JSON array / whitespace-only → default; legacy `"new-window"` wins until
  superseded; a live-session Terminal change shows `app-presentation-change-confirm` (Cancel via
  `app-presentation-change-cancel` leaves the host intact).

- [ ] **F-5 (R-5 / AC5) — every entry point honors the choice and the standalone window's capabilities work.**
  Set an app to `new-window`; open it from EACH entry point in turn: launcher grid tile, Open-apps row
  (`launcher-open-apps` → `launcher-open-app-entry-<windowId>`), `fredo open-app`, companion
  `open_app`/`close_app` skill, and `openSelf`. In the standalone window, inject `fredo emit` chat/tool
  events and observe live rows; then close via the entry point.
  **Expected:** every entry point honors the stored mode (opens the separate OS window with
  `app-window-root`); `close_app` closes the native host and reports honestly (`closeAppOwnWindow`
  true only when a window existed); the standalone app renders its real UI, live `useEventRows`
  subscriptions update from injected events, and `onMount`/`onUnmount` fire on open/close.
  **Edge:** `close_app` with no native window → false, no error; `fredo open-app` for a `new-window`
  app is not falsely reported as "not open"; unknown id → `app-window-unknown`.

- [ ] **F-6 (E2E, mandatory) — boots on the PG-default path, Mission Monitor renders live sessions, and the per-app choice works.**
  Cold-start the dev app on the PG-default path; confirm Mission Monitor renders live sessions
  (inject `fredo emit --event-type chat` + `--event-type tool_use` with distinct session ids; rows
  appear); set Mission Monitor to `new-window` and open it from the launcher; query `telemetry_spans`.
  **Expected:** (a) the app boots on the PG-default path (managed postgres up, app connects — no
  fallback-store error); (b) Mission Monitor still renders the injected live sessions; (c) the per-app
  window choice opens the app in its own separate OS window; `telemetry_spans` is non-zero with a
  recent `max(ingested_at)`.
  **Edge:** restart between legs; PG pool saturated → `telemetry_get_stats` fallback (disclosed); a
  cold app with no prior window state.
