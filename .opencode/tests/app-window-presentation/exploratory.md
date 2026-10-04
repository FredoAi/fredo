# Exploratory — app-window-presentation

> Unscripted probes for edge/failure states the QA Plan cannot enumerate. A confirmed finding
> **promotes** to `functional.md` as a new `F-` row (keep the origin note). Each probe names the
> in-repo lever that induces it (G-275/G-300).

## Prompts

- [ ] **E-1 — Concurrency: two entry points race.** Fire the launcher tile and `fredo open-app` for the same `new-window` app within one tick. Does the Rust label-keyed singleton still yield exactly one window, or does a focus/close race leave a duplicate? Lever: rapid back-to-back invocations; observe `tauri_manage_window list`.
- [ ] **E-2 — Mode change with a live standalone host.** Change an app from `new-window` to `same-window` WHILE its native window is open (and a Terminal session is live). Does the superseded host close cleanly (no orphan process, no duplicate), and does the confirm dialog (`app-presentation-change-confirm`) behave on Cancel? Lever: `set_setting` + `close_app_window` observers + `process-hygiene.ps1 -List`.
- [ ] **E-3 — Store corruption shapes.** Seed `app_window_presentation` with `null`, `[]`, `42`, `{"terminal":null}`, and a deeply nested object. Does hydration recover to `same-window` without throwing? Lever: `set_setting` via `execute_js`.
- [ ] **E-4 — Unknown generic route id.** Force `index.html?view=app&id=__no_such_app__` (navigate the standalone webview). Does `app-window-unknown` render with no crash and no blank? Lever: generic route with an unregistered id.
- [ ] **E-5 — Restart mid-flight.** Restart the app while a `new-window` host is open. Does the next boot restore the in-window default (native windows are not persisted) and leave no orphaned process? Lever: `dev-env.ps1 -Action Restart`; `process-hygiene.ps1 -List`.
- [ ] **E-6 — Standalone capability probe.** In a generic standalone window, exercise a capability not covered by F-5 (e.g. resize/persist a panel) and check for a re-render loop or missing provider. Lever: `tauri_read_logs(source="console")`.
