# Voice Input — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the voice-input surface.
> Runs on a running Fredo POC on `spec/2876`. **Verification policy: live.**
> **Serving checkout:** `spec/2876 @ <sha>` (fill per round).

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Feature surface reachable — the launcher command bar renders (`input[role="searchbox"]`, `LauncherCommandBar.tsx:133`); open the launcher via the activation lever and assert the bar is present and focusable
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible (and confirm NO voice/STT/autosend section exists — autosend is out of spike scope)
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2876/e2e/smoke.jpeg")` succeeds

## #2876 extension — STT spike smoke

- [ ] S-6: Listening flow starts and stops — activate the listening flow (bar-focused branch), assert a listening cue appears before the first partial (e.g. placeholder `Listening…` / accent-tinted border), then stop; the app returns to the resting bar with no console `Error:`/`Uncaught`/`Maximum update depth exceeded` and `tauri_webview_screenshot` succeeds. **Test data:** real mic (or fixture). **If no mic/permission → named blocker (G-053) + unit/static pin, not a PASS.**
- [ ] S-7: Offline smoke — with the network blocked (and the block proven by a failing control fetch), start → speak a short phrase → stop; a transcript appears in the bar input and the app stays alive. **Test data:** network block + control fetch; real mic (or fixture).
- [ ] S-8: Evidence upload smoke — a capture is uploaded via `upload-evidence --issue 2876 --base spec/2876`, the raw URL resolves, and it is embedded in `## Tests Runs` with a textual description (the live-policy lever).
