# Terminal — Smoke Test Suite

Feature domain: `terminal` (renamed Run CLI surface). Standard boilerplate adapted from
`.opencode/tests/README.md` plus feature-specific quick paths for Spec #2934.

Conventions: ID prefix `S-`. Observable expected outcomes.

## Feature usage: launching sessions in the Terminal window

After #2934 the flow is: click the **Terminal** desktop item in the maomaolabs toolbar →
ONE `terminal` Tauri window opens hosting a session sidebar → add sessions (OpenCode or
GitHub Copilot) → select one to view its live terminal. There is NO per-session window.

1. Click the **Terminal** desktop item in the maomaolabs toolbar.
2. `tauri_manage_window(action="list")` → expect the main window + exactly ONE `terminal`
   window (label `terminal`, title `Terminal`).
3. Add a session: choose `OpenCode` and/or `GitHub`. The sidebar lists each session.
4. Drive the active session's PTY over IPC:
   `tauri_webview_execute_js` (windowId `terminal`) → `__TAURI__.core.invoke('write_pty_input', { sessionId: '<id>', data: "<cmd>\r" })`
   (trailing `\r` mandatory, G-037); read output via
   `__TAURI__.core.invoke('get_pty_buffer', { sessionId: '<id>' })`.
   The `Starting OpenCode…` overlay is a LOADING state — wait through it (first launch can
   take up to ~60 s) before concluding a launch failed.
5. Close a session from the sidebar → only that session's processes stop; the window stays
   open if a session remains. Close the window → all sessions reaped.

**Never invoke `opencode`/`copilot` from a shell.** The app resolves and launches them. Never
touch `~/.config/opencode/*` or `%APPDATA%\com.fredo.app\*` directly. For the AC4 negatives,
use the documented levers (the binary-path override / `dev-env.ps1 -EnvVar` seams) — never
uninstall a binary or edit the OS PATH.

## Cases

- [ ] S-1: **App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a
  non-empty `<body>`.
- [ ] S-2: **No console errors** — `tauri_read_logs(source="console", lines=50)` shows no
  `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: **Terminal surface reachable** — the `Terminal` desktop item renders in the
  maomaolabs toolbar and is clickable.
- [ ] S-4: **Settings accessible** — Settings → Terminal section renders (Telemetry +
  Companion + Appearance sections still present).
- [ ] S-5: **Screenshot captured** —
  `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2934/e2e/smoke.jpeg")`
  succeeds.
- [ ] S-6: **One window (quick path)** — click the Terminal toolbar item;
  `tauri_manage_window(action="list")` shows main + exactly ONE `terminal` window and stays
  there through launch. Full assertions in `functional.md` F-2/F-6.
- [ ] S-7: **Sidebar renders (quick path)** — the `terminal` window DOM shows the session
  sidebar + add-session control. Full assertions in F-6/F-7.
- [ ] S-8: **OpenCode session launches (quick path)** — add an OpenCode session; the session
  reaches `running` and its PTY buffer becomes non-empty. Full assertions in F-6/F-8.
- [ ] S-9: **GitHub Copilot session launches (quick path, live)** — add a GitHub session; a
  Copilot TUI renders (or the AC4 error surface shows, never a hang). Full assertions in
  F-13.
- [ ] S-10: **Switch sessions (quick path)** — click each sidebar item; the active session
  changes and the window count stays main + 1. Full assertions in F-9/F-10.
- [ ] S-11: **Close session + window reaps processes (quick path)** — close one session
  (the other survives), then close the window; `process-hygiene.ps1 -List` shows no orphaned
  opencode/copilot/node process. Full assertions in F-19/F-20.
- [ ] S-12: **Rename quick check** — window label `terminal`, title `Terminal`, toolbar item
  reads `Terminal`; the zero-match receipts in `regression.md`/F-1 pass. Full assertions in
  F-1..F-3.
- [ ] S-13: **Persist + list (quick path)** — add a session, close the `terminal` window, reopen;
  the session is still listed with its CLI + workDir. Full assertions in F-22/F-23.
- [ ] S-14: **Resume (quick path)** — resume a persisted record; a PTY starts and its buffer is
  non-empty. Full assertions in F-24/F-25 (the sentinel + the fresh-session control).
- [ ] S-15: **Teardown receipt (quick path)** — close the window with sessions live;
  `process-hygiene.ps1 -List` reports `0 opencode/node/copilot process(es)` and the records are still
  listed on reopen. Full assertions in F-27/F-28.
- [ ] S-16: **CLI open (quick path)** — `fredo open-terminal --cli opencode --dir
  C:\Code\fredo\.opencode\tests\terminal\fixtures\workdir-a` → exit 0 and the `terminal` window opens
  with an OpenCode session in that dir. Full assertions in F-33/F-34.

### #2935 testing round 1 (spec/2935 @ 9ad0b360) — results

- **S-1 PASS.** `tauri_webview_dom_snapshot`/DOM non-empty (launcher + window manager render).
- **S-2 PASS.** No `Error:`/`Uncaught`/`Maximum update depth exceeded` in the main OR `terminal`
  window console (only the pre-existing `motion() is deprecated` WARN + `[ghostty-vt]` renderer WARNs).
- **S-3 PASS.** The `Terminal` desktop item renders on the revealed launcher grid
  (`div[aria-label="Terminal"]`) and is clickable.
- **S-4/S-5 PASS (from #2934 rounds).**
- **S-6 PASS.** Launcher click → `main + 1 terminal` window; re-invoke focuses (no duplicate).
- **S-13 PASS.** Add session → close window → reopen lists it ("Previous sessions").
- **S-14 PASS.** Resume a persisted record → a PTY starts (`status=running`) and its buffer is
  non-empty and contains the prior conversation (`TERMINAL_RESUME_2935_SENTINEL`).
- **S-15 PASS.** Close the window with sessions live → `process-hygiene.ps1 -List` shows the terminal
  session trees gone, 0 unprotected orphans; the records are still listed on reopen.
- **S-16 PASS.** `fredo open-terminal --cli opencode --dir …\workdir-b` → exit **0**
  `{"cli":"opencode","outcome":"started","workDir":"…\\workdir-b"}`, the `terminal` window opens,
  a session with that cli+workDir spawns and is auto-selected (no dialog).

## #2940 — full-height composition + fixture isolation (quick paths)

> Seeded at triage for Spec #2940. Quick smoke paths; full assertions live in the named
> `functional.md`/`regression.md` rows. Evidence is LIVE + MEASURED (window list / geometry
> probe / DOM / PTY buffer / process inventory). AC1/AC2 need the measured numbers — a quick
> smoke frame alone never clears them.

- [ ] S-17: **Terminal window opens full-height (quick path)** — open the `terminal` window
      at the default size; run the geometry recipe from `functional.md`.
      EXPECTED: the pane's `bottom`/`right` are within ~2 px of the window edges and there is
      no dead band ≥8 px below/beside the canvas (no scrollbar). Full assertions in F-37.
- [ ] S-18: **Workspace reads coherently (quick path)** — screenshot the window at the default
      size with ≥1 session (save under `.opencode/tmp/2940/e2e/`).
      EXPECTED: the terminal is the dominant surface; the session nav + status are subordinate
      and legible. Full assertions in F-42/F-44.
- [ ] S-19: **Every state surface still reachable (quick path)** — force `empty`, `error`
      (`invalid-cli`), and `resume` in turn and confirm each testid renders inside the pane.
      Full assertions in F-45/F-48/F-50 (the full AC3 matrix).
- [ ] S-20: **Suites leave no fixture record (quick path)** — snapshot
      `list_persisted_terminal_sessions`, run one terminal suite row that spawns a session,
      re-read.
      EXPECTED: the record set is unchanged (no fixture workdir/title). Full assertions in
      F-51/F-52.

### #2940 testing round 1 (spec/2940 @ 6a8b2c6d) — results

- **S-1 PASS.** `tauri_webview_dom_snapshot`/DOM non-empty in the main window; the `terminal`
  window DOM renders `terminal-session-bar` + `terminal-pane`.
- **S-2 PASS.** No `Error:`/`Uncaught`/`Maximum update depth exceeded` in EITHER window (only the
  pre-existing `motion() is deprecated` WARN + `[ghostty-vt]` renderer WARNs).
- **S-3..S-7 PASS (from prior rounds).** `tauri_manage_window(action="list")` = main + exactly ONE
  `terminal` window (label `terminal`, title `Terminal`, `?view=terminal`) through every launch.
- **S-8/S-9 PASS.** OpenCode and GitHub Copilot both reach `running` in the reworked composition.
- **S-13/S-14 PASS.** Persist + list + resume (record id reused, PTY non-empty).
- **S-15 PASS.** Close the window with sessions live → the trees are reaped, 0 unprotected orphans;
  records survive.
- **S-16 FAIL (cold leg).** With the `terminal` window CLOSED, `fredo open-terminal --cli opencode
  --dir …\workdir-a` → exit-JSON `{"outcome":"started"}` + the window opens, but the session does NOT
  spawn (4/4 cold runs). Warm (window already open) → spawns + auto-selected (3/3). See
  `regression.md` R-18 for the root cause + receipts.
- **S-17 PASS.** Default-size geometry: pane `900×556` flush to the window (`right` 900, `bottom` 600),
  no dead band below/beside the host, `docScrollH` 600 (no scrollbar).
- **S-18 PASS.** Workspace reads coherently at 900×600 (dark + light): terminal dominant, one 44 px
  rail with subordinate per-session status.
- **S-19 PASS.** `empty`, `error` (`invalid-cli`) and `resume` each rendered in turn inside the pane
  (`data-surface` per state + its preserved testid).
- **S-20 PASS.** The C-5 teardown left zero fixture-root records; the read-only store query returned
  no rows.

## #2942 — vertical sidebar, rename, plain shell (quick paths)

> Seeded at triage for Spec #2942. Quick smoke paths only; full assertions live in the named
> `functional.md` rows. AC1 needs the measured geometry NUMBERS from the served host document —
> a quick smoke frame never clears it. Replace the `<issue>` token in S-24's path with the spec
> issue number.

> **EARS map (Architect-authoritative):** S-21 → R-1.1; S-22 → R-3.1/R-3.2; S-23 → R-2.2/R-2.4;
> S-24 → R-4.1; S-25 → R-4.4 + G-250. Published hooks/gates: see `functional.md` →
> "Requirement-ID reconciliation" (bind to either published form; flag a miss as a TOOLING GAP).

- [ ] S-21: **Vertical sidebar renders (quick path)** — open the `terminal` window with ≥1 session
      and query the sidebar root (`terminal-session-sidebar`) + the live rows.
      EXPECTED: a full-height COLUMN with full-width compact rows; NO `terminal-session-bar` and NO
      `[role="tablist"]`. Full assertions in F-57/F-58.
- [ ] S-22: **Plain-shell default (quick path)** — clear the default key + `localStorage`, restart,
      add a session with no override.
      EXPECTED: a shell prompt appears in the PTY buffer and no agent process is spawned. Full
      assertions in F-66/F-67.
- [ ] S-23: **Rename (quick path)** — rename a session; the new name renders on the row (and, after
      close/reopen, on the previous row). Full assertions in F-62/F-64.
- [ ] S-24: **Settings → Terminal (quick path)** — open Settings → Terminal; a default-TYPE control
      (3 choices) + the working-directory input render.
      EXPECTED: Save persists; a screenshot at
      `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/2942-settings.jpeg")`
      succeeds. Full assertions in F-69/F-70.
- [ ] S-25: **Cold `fredo open-terminal` (quick path)** — close the `terminal` window (assert 0),
      run `fredo open-terminal --cli opencode --dir …\fixtures\workdir-a`.
      EXPECTED: exit 0, the window opens, a session spawns (COLD — G-250). Full assertions in F-77/R-24.

## C-5 teardown (MANDATORY — run after this suite; BINDING, Architect C-5)

> **#2942 delta:** also snapshot/restore the default-TYPE key (published; fallback
> `terminal_default_cli`) and snapshot every pre-existing record's `{id → title}` (G-242). Full
> detail: `functional.md` → "Teardown delta for #2942".

> Suite-side, no product change. Run in the `terminal` window via `tauri_webview_execute_js`
> after every run; then restore the four settings keys. Deletes every persisted record whose
> `workDir` is under the in-repo fixtures root. Full detail: `functional.md` →
> "C-5 teardown / snapshot / settings-restore".

```js
(async () => {
  const FIX = String.raw`.opencode\tests\terminal\fixtures`.toLowerCase();
  const recs = await window.__TAURI__.core.invoke('list_persisted_terminal_sessions');
  const doomed = recs.filter(r => String(r.workDir || '').toLowerCase().includes(FIX));
  for (const r of doomed) {
    await window.__TAURI__.core.invoke('delete_terminal_session_record', { sessionId: r.id });
  }
  const left = await window.__TAURI__.core.invoke('list_persisted_terminal_sessions');
  return { deleted: doomed.map(r => [r.id, r.title, r.workDir]), remaining: left.map(r => r.id) };
})()
```

- Pre-run snapshot: the record id set + the four settings keys (`terminal_work_dir`,
  `terminal_default_cli`, `terminal_copilot_path`, `terminal_pwsh_path`); compare AFTER.
- Settings restore (binding): restore those four keys to their captured pre-run values.
- Cross-suite repeat: `.opencode/tests/run-cli/regression.md`.

### #2940 testing round 2 (spec/2940 @ a4b4dfa1) — results

Cold-restarted the dev instance so the round-2 Rust fix `b303ba9` was built+served.

- **S-1..S-7 PASS.** Main + exactly ONE `terminal` window (label `terminal`, title `Terminal`,
  `?view=terminal`) through every launch; both windows' console clean.
- **S-16 PASS (was round-1 FAIL).** Cold (no `terminal` window open)
  `fredo open-terminal --cli opencode --dir …\workdir-a` → exit-JSON `{"outcome":"started"}`,
  window opened, session spawned + auto-selected — **3/3 cold** (`7f3c8ad9`, `c1d44309`,
  `78470a18`, all RUNNING with the requested cli+workDir). One-shot: re-list ×4 + reload kept
  exactly 1 session. Warm 3/3 spawned exactly one new session each. See `regression.md` R-18.
- **S-17/S-18/S-19/S-20 PASS.** Default-size pane flush (`900×556`, `right` 900, `bottom` 600,
  no scrollbar); coherent workspace at 900×600; `empty`/`error`/`resume` (+ `starting`,
  `ended`, `all-ended`, `resuming`, `resume-blocked`) each rendered inside the pane; the C-5
  teardown left 0 fixture-root records (run 1 deleted 3 / run 2 deleted 0).

### #2942 testing round 1 (spec/2942 @ 3241b90d) — results

- **S-1/S-2 PASS.** DOM non-empty in both windows; no `Error:`/`Uncaught`/`Maximum update depth
  exceeded` in either console (only the pre-existing `motion() is deprecated` WARN + `[ghostty-vt]`
  renderer warnings).
- **S-3/S-6 PASS.** The `Terminal` desktop item launches exactly ONE `terminal` window (label
  `terminal`, title `Terminal`, `?view=terminal`); re-invoking focuses (window count stayed 2).
- **S-4/S-24 PASS.** Settings → Terminal renders alongside Companion/Appearance/Fredo Setup/Telemetry.
- **S-13 PASS.** Add a session → close the window → reopen lists it in the sidebar's `Previous` group.
- **S-21 PASS (with a defect).** The vertical sidebar root `terminal-session-sidebar` + `-add` +
  `-live-section` + `-previous-section` and full-width 32 px live rows render; NO `terminal-session-bar`
  and NO `[role=tablist]`. **F-80 FAIL (new):** in the 0-live state the sticky `Previous (N)` header
  overlaps the first previous row by 23 px (label hidden).
- **S-22 PASS.** With the default key + `localStorage` cleared + a cold restart, adding a session with
  no override spawns a plain PowerShell shell (record `cli=shell`); no agent process.
- **S-23 PASS.** Rename renders on the live row, on the previous row after close/reopen, and survives a
  full app restart (`TERMINAL_RENAME_2942_e5f6a7b8`).
- **S-25 PASS (cold).** `fredo open-terminal --cli opencode --dir …\workdir-a` with 0 `terminal` windows
  → exit 0, the window opens, a RUNNING session spawns + auto-selects — **cold 3/3** + warm control.
- **S-20 PASS.** C-5 teardown run 1 deleted 23 / run 2 deleted 0 (idempotent) → 0 fixture-root records;
  the four settings keys restored.
- **New: S-26 (from F-81).** `fredo open-terminal --help` shows `--cli <opencode|copilot>` — the new
  `shell` value is missing from the usage/value-name (FAIL; behaviour is correct).

### #2942 testing round 2 (spec/2942 @ 97495693) — results (retry; PASS)

- **S-1/S-2 PASS.** DOM non-empty in both windows; consoles clean on both (only the pre-existing
  `motion() is deprecated` WARN + `[ghostty-vt]` renderer warnings).
- **S-3/S-6 PASS.** The `Terminal` desktop item launches exactly ONE `terminal` window (label `terminal`,
  title `Terminal`, `?view=terminal`); re-invoking focuses (count stayed 2).
- **S-4/S-24 PASS.** Settings → Terminal renders the 3 type choices + work-dir input alongside
  Companion/Appearance/Fredo Setup/Telemetry.
- **S-13 PASS.** Add a session → close the window → reopen lists it in the sidebar's `Previous` group.
- **S-21 PASS.** Vertical sidebar root `terminal-session-sidebar` + `-add` + `-live-section` +
  `-previous-section` and full-width 32 px rows render; NO `terminal-session-bar` and NO `[role=tablist]`.
  **F-80 now PASS** — sticky Previous header no longer overlaps the first previous row (0 px).
- **S-22 PASS.** With the default key + `localStorage` cleared, adding a session with no override spawns
  a plain PowerShell (`cli=shell`); no agent process.
- **S-23 PASS.** Rename renders on the live row, on the previous row after close/reopen, and survives a
  full app restart (`TERMINAL_RENAME_2942_e5f6a7b8`).
- **S-25 PASS (cold).** `fredo open-terminal --cli opencode --dir …\workdir-a` with 0 `terminal` windows
  → exit 0, the window opens, a RUNNING session spawns + auto-selects — **cold 3/3** + warm control.
- **S-20 PASS.** C-5 teardown run 1 deleted 7 / run 2 deleted 0 (idempotent) → 0 fixture-root records;
  the four settings keys restored.
- **S-26 now PASS (F-81 fixed).** `fredo open-terminal --help` shows
  `--cli <shell|opencode|copilot>` + the `shell` type in the description.
