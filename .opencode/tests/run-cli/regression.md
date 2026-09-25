# Run CLI — Regression Test Suite

Feature domain: `run-cli`. Baseline invariants for Spec #2728 (single-window launch + ghostty-web terminal), extended for Spec #2731 (toolbar-item launch affordance).
These cases verify behavior that MUST NOT change while this spec lands.
Spec #2731 scope note: the terminal-window behavior itself (Ghostty rendering, session lifecycle, working-directory resolution) is out of scope for #2731 — it is re-verified live only. The ONLY intended change is the launch affordance (floating "RUN CLI" button → maomaolabs toolbar desktop item) and the removal of redundant surfaces.

Conventions: ID prefix `R-`; observable expected outcomes. On pass keep the checkbox and append evidence; on fail mark `FAIL`.

## No-change baseline (Spec #2728 non-goals)

- No changes to the opencode session logic (spawn/PTY/event pipeline beyond the window + launch-flow surface).
- No migration of other terminal surfaces (only the Run CLI terminal window switches to ghostty-web).
- Run CLI settings UI changes limited to keeping the working-directory preference functional.
- Spec #2731 adds: no changes to terminal window behavior, no new settings/configuration surface, no changes to other toolbar desktop items.

## Cases

- [x] R-1: **opencode session logic intact.** The real opencode CLI session still spawns, runs, and emits `run-cli-output` / `run-cli-exited` events plus `run_cli` Hook events (`EventBus`, `tool_name="run_cli"`, per `commands.rs`); `telemetry_spans` still records the session's `fredo.*` spans. Expected: the session under test behaves identically to pre-spec — only the window/rendering surface changed. **PASS** — Session `ses_003810aeaffeEik27v6fuc2DhW` has `fredo.session`, `fredo.llm`, `fredo.tool.bash` spans (6 total, all OK). FIX-1 uses `emit_to` targeting the `run-cli-terminal` window instead of broadcast `AppHandle::emit`. Evidence: Spec #2728 round 2 `## Tests Runs`, `telemetry_spans`. (Re-verified with a toolbar-launched session in the #2731 round.)

- [x] R-2: **No migration of other terminal surfaces.** Any other surface rendering terminal-style output (e.g. query-viewer output, dev-mode logs) still renders with its pre-spec renderer — the xterm→ghostty change is scoped to the Run CLI terminal window only. Expected: other surfaces visually unchanged; no new renderer dependency outside the Run CLI terminal component. **PASS** — No other terminal surfaces affected. Ghostty-web only used in RunCliTerminalWindow.tsx. Evidence: Spec #2728 round 1.

- [x] R-3: **Run CLI settings surface unchanged except the preference.** The settings UI still exposes and persists the working-directory preference (`run_cli_work_dir`); no other settings surface is added/removed by the spec. Expected: `settingsService`/`get_setting` read-write for `run_cli_work_dir` works and the value is applied on next launch. **PASS** — Settings UI works, value persists, applied on next launch. Evidence: Spec #2728 round 1 `## Tests Runs`.

- [x] R-4: **PTY command contract preserved.** `open_run_cli` (work_dir arg), `get_pty_buffer`, `write_pty_input`, `resize_pty`, `close_run_cli` still function: keyboard input (F-5), output replay on window mount, PTY resize on window resize, and stop/close all work through the same command surface. Expected: no rename/removal of these commands; behavior unchanged. **PASS** — `get_pty_buffer` returns live PTY content. `write_pty_input` sends keystrokes that reach the process. `close_run_cli` closes the window. Evidence: Spec #2728 round 2 `## Tests Runs`.

- [x] R-5: **Single-instance semantics.** Repeated clicks on "Run CLI" while a session is running never open a second window — the existing single window is focused/reused. Expected: window count stays at main + 1 after a double-click. **PASS** — Window count stayed at 2 (main + terminal) throughout testing. Evidence: Spec #2728 round 1. (Re-asserted for the toolbar item in F-19 / R-5.)

- [x] R-6: **Main window health.** No console errors (`Error:` / `Uncaught` / `Maximum update depth exceeded`) in the main window during launch, streaming, and close of the terminal window. Expected: clean main-window console. **PASS** — Console clean (zero errors). Evidence: Spec #2728 round 1 `## Tests Runs`.

- [x] R-7: **Work-dir fallback preserved.** With `run_cli_work_dir` unset, launch still falls back to `USERPROFILE`/`HOME` (pre-spec `commands.rs` behavior). Expected: session starts in the home directory. **PASS** — Verified via `get_setting` that `run_cli_work_dir` defaults to `C:\Code\fredo` when set. The fallback logic in `commands.rs` is unchanged (code inspection + FIX-2 adds cwd validation before spawn, preserving the fallback path). Evidence: Spec #2728 round 2 `## Tests Runs`.

## #2731 regression cases

- [x] R-8: **Other maomaolabs toolbar desktop items unchanged.** Every other showable feature's toolbar desktop item still renders and launches its feature exactly as pre-spec. Expected: sibling items identical in set, labels, ordering, and launch behavior; only the Run CLI item is new, and no other item's behavior is altered. Evidence: DOM snapshots of the toolbar before/after; per-item launch spot-check of at least one sibling. **PASS** — DOM shows Mission Monitor and Query Viewer items unchanged. Toolbar items: Open Menu, Run CLI, Mission Monitor, Query Viewer. Evidence: DOM snapshot at 2026-08-13T21:01:04Z.

- [x] R-9: **#2728 terminal behavior baseline intact via toolbar launch.** Ghostty rendering (F-3), PTY command contract (`open_run_cli`, `get_pty_buffer`, `write_pty_input`, `resize_pty`, `close_run_cli` — R-4), session lifecycle and events, and `telemetry_spans` `fredo.*` emission all still work when the session is launched from the toolbar desktop item. Expected: ONLY the launch affordance changed; the terminal/session surface is byte-comparable to #2728 (same window, same renderer, same commands). **PASS** — Ghostty canvas 882×555px, xtermCount=0, PTY buffer 11397 bytes, Run CLI status `{status: "running", error: null, workDir: "C:\\Code\\fredo"}`. Evidence: JS checks at 2026-08-13T21:03:01Z, 2026-08-13T21:05:13Z.

- [x] R-10: **Run CLI settings surface unchanged.** `run_cli_work_dir` is still editable via Run CLI settings and is applied on the next toolbar launch. Expected: R-3 behavior identical; the toolbar launch consumes the same preference key. No settings surface added or removed. **PASS** — Settings persist via `save_setting` IPC, applied on next launch. Evidence: setting save/restore at 2026-08-13T21:06:54Z, 2026-08-13T21:07:10Z.

- [x] R-11: **No new settings/configuration surface introduced.** No new settings keys, dialogs, or config UI beyond what #2728 delivered (the removed floating button introduces nothing). Expected: settings surface and keys unchanged from #2728 (feature Settings section count and keys identical). **PASS** — No new settings keys or UI. Only change is removal of floating button. Evidence: code review of spec branch.

- [x] R-12: **Desktop grid / showable features unaffected.** Registering Run CLI as a maomaolabs toolbar desktop item does not disturb the desktop grid or other showable features' rendering; main-window console stays clean. Expected: desktop renders without layout regressions; other showable features open/close normally. **PASS** — Desktop renders normally, console clean. Evidence: DOM snapshot at 2026-08-13T21:01:04Z, console at 2026-08-13T21:00:17Z.

## #2934 pre-rename regression cases (Spec #2934 baseline)

> Spec #2934 (Run CLI → Terminal, multi-session) MUST leave the legacy single-session
> behaviors true wherever they are still reachable, and retire them only deliberately.
> These rows are the "must not change" baseline for the rename diff. Run them in addition
> to `.opencode/tests/terminal/regression.md`, whose `R-` rows assert the new surface.
> Cross-suite: `window-manager/regression.md` R-2 (window lifecycle), `settings/`
> (settings surface/key safety), `copilot-capture/` (capture path untouched).

- [ ] R-13: **Single-window invariant preserved through the rename.** After the rename, the
  launch affordance is the `Terminal` toolbar item and exactly ONE `terminal` window ever
  exists (main + 1); no per-session window is introduced.
  EXPECTED: window count = main + 1 at every sample while 2+ sessions run.
  Edge: rapid double-click; launch during startup; launch from the error state.
  Full assertions: `terminal/functional.md` F-6 / `regression.md` R-4.

- [ ] R-14: **Working-directory preference survives the key rename.** The legacy
  `run_cli_work_dir` value is migrated to the new key and honored; unset → home fallback
  (pre-rename `commands.rs` behavior) is preserved.
  EXPECTED: migrated value governs; fallback unchanged.
  Full assertions: `terminal/functional.md` F-4/F-5; `terminal/regression.md` R-3.

- [ ] R-15: **No orphan regression (the pre-rename gap must not persist).** The prior
  single-window kill path reaped only the direct child; on Windows `.cmd`→`node.exe`
  descendants could survive. After #2934, closing a session or the window must leave ZERO
  Fredo-spawned `opencode`/`copilot`/`node` processes.
  EXPECTED: `process-hygiene.ps1 -List` shows no orphan after each close.
  Edge: close during startup; close two sessions back-to-back; window close via OS X.
  Full assertions: `terminal/functional.md` F-19/F-20.

- [ ] R-16: **Settings + telemetry surfaces untouched.** The rename touches the Terminal
  settings section and keys only; other settings sections and the OTLP/RTDB telemetry path
  are unchanged, and the OpenCode session still emits `fredo.*` spans.
  EXPECTED: no change to `infrastructure/rtdb/` or the OTLP receivers in the diff; other
  settings sections render identically.
  Full assertions: `terminal/regression.md` R-7/R-9/R-10.

- [ ] R-17: **No persistence introduced (non-goal).** Sessions remain in-memory for the
  window's life; a restart yields an empty sidebar and no persisted session rows.
  EXPECTED: no `terminal` session rows in `fredo.db`; no resume.
  Full assertions: `terminal/functional.md` N-5 / `regression.md` R-8.

## #2942 pre-rename-suite regression cases (vertical sidebar / rename / plain shell)

> Seeded at triage for Spec #2942. This suite is the pre-rename baseline; the #2942 rework
> (horizontal rail → vertical sidebar, rename, plain-shell default, Settings type) must not
> regress the CLI open path or the multi-session/session-scoped PTY contract. These rows
> complement `.opencode/tests/terminal/regression.md` R-20..R-27. Evidence: LIVE.

> **EARS map (Architect-authoritative):** R-18 → the cold-open contract + G-250; R-19 → R-4.4
> (`--cli shell` accepted; no-`--cli` uses the stored default); R-20 → R-5.1 + R-5.2.
> Published hooks/values (RECONCILED at convergence): the plain-shell wire value is `shell`
> (frontend `TerminalSessionKind`; display label "Terminal"); see
> `.opencode/tests/terminal/functional.md` → "Requirement-ID reconciliation".

- [ ] R-18 (**AC5, G-250 — the cold `fredo open-terminal` leg holds after the rework**): close the
      `terminal` window (assert 0), then `fredo open-terminal --cli opencode --dir
      C:\Code\fredo\.opencode\tests\terminal\fixtures\workdir-a`.
      EXPECTED: exit 0 + `{"outcome":"started"}`, ONE `terminal` window, a RUNNING OpenCode session
      with that cli+workDir auto-selected — **COLD** (repeat ≥3×) plus a warm control. A cold run
      that opens the window but spawns NOTHING is a FAIL. Negatives: `--cli bogus` →
      `{"outcome":"invalid-cli"}`, `--dir …\no-such-dir` → `{"outcome":"invalid-directory"}`, session
      list unchanged.
      Edge: rapid cold invocations; window closed with a state surface showing.

- [ ] R-19 (**AC5 — the CLI default path accepts the new plain-shell type**): with the Settings default
      type = Terminal (plain shell) and NO `--cli`, run `fredo open-terminal` (window closed, cold);
      separately, if the wire value is exposed, `fredo open-terminal --cli shell`.
      EXPECTED: exit 0, the `terminal` window opens, and a PLAIN SHELL session spawns (no agent
      process; a shell prompt in the PTY buffer); `--cli` validation still rejects unknown values
      (`invalid-cli`) and a blank `--cli` (`invalid-argument`). A plain-shell launch must not resolve
      to an OpenCode/Copilot agent.
      Edge: `--cli` omitted with a saved non-default type; blank `--dir` (no error).

- [ ] R-20 (**AC5 — plain-shell records persist + list in the sidebar**): spawn a plain-shell session
      via the CLI; close the `terminal` window; reopen.
      EXPECTED: the record is still listed (its type + workDir) in the sidebar's previous-session
      rows (`terminal-previous-session-row-<id>`); reopening starts 0 processes; resume reopens a
      shell in the directory (no false conversation-resume copy).
      Edge: a shell record whose dir was removed → typed blocked state (record retained).

## #2940 C-5 teardown (MANDATORY — run after this suite)

> **#2942 delta:** also snapshot/restore the default-TYPE key (published; fallback
> `terminal_default_cli`) and snapshot every pre-existing record's `{id → title}` (G-242). Full
> detail: `.opencode/tests/terminal/functional.md` → "Teardown delta for #2942".

> This pre-rename suite also spawns sessions against the running dev instance, so it leaks
> persisted Terminal records the same way `.opencode/tests/terminal/` does. Spec #2940's
> binding C-5 fix repeats the mandatory teardown here. Run it in the `terminal` window via
> `tauri_webview_execute_js` after every run of these rows, then restore the four settings keys.

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
- Full detail: `.opencode/tests/terminal/functional.md` → "C-5 teardown / snapshot /
  settings-restore"; ST-5 adds `fixtures/purge-fixture-records.js` for the one-time purge.

## Round notes

### Round 1 — 2026-09-24, spec/2934 @ 1fd60694

- R-13 PASS — one `terminal` window (main+1) at every sample with 6 sessions / 2 running.
- R-14 PASS — legacy `run_cli_work_dir` migrated onto `terminal_work_dir`; rewriting only
  the legacy key does not move Terminal's dir; blank → home-fallback semantics retained.
- R-15 PASS — no orphan after close-one (wrapper + opencode child gone, other survives),
  self-exit (only that session `exited`), or window-close (all reaped); `-List` = 0 orphans.
- R-16 PASS — no `infrastructure/rtdb/**` / `infrastructure/otlp/**` in the diff; other
  settings panes unchanged.
- R-17 PASS — empty sidebar after restart; no `%terminal%` table in `fredo.db`.
- Legacy single-session note: the old auto-close-on-exit (`commands.rs:362-364`) is
  deliberately removed — a session self-exit keeps the window open (verified live).

### Round 2 — 2026-09-24, spec/2934 @ a656a020

- R-13 PASS — one `terminal` window (main+1) at every sample with 2–4 sessions / 2+ running.
- R-14 PASS — legacy `run_cli_work_dir` migrated onto `terminal_work_dir` (workdir-b) with a
  0-keystroke dialog prefill; rewriting only the legacy key does not move Terminal's dir;
  blank → home-fallback semantics retained.
- R-15 PASS — no orphan after close-one (that session's tree gone, the other survives),
  self-exit (only that session `exited`), or close-window (all reaped);
  `process-hygiene.ps1 -List` = 0 unprotected orphan candidates.
- R-16 PASS — no `infrastructure/rtdb/**` / `infrastructure/otlp/**` in the #2934 diff; other
  settings panes unchanged (Settings nav renders Terminal alongside the static sections).
- R-17 PASS — empty sidebar after restart; no `%terminal%` table in `fredo.db`.

### Round 3 — 2026-09-24, spec/2934 @ 7ba5a99c

- R-13 PASS — one `terminal` window (main+1) at every sample while up to 5 sessions ran
  (OpenCode ×2, Copilot ×2, fixture ×1).
- R-14 PASS — the legacy `run_cli_work_dir` read remains the single allowlisted hit
  (`terminal/settings.ts:18`); migration code untouched this round; `terminal_work_dir`
  governs live (add-session dialog prefill = `…\fixtures\workdir-b`).
- R-15 PASS — close-one reaps that session's tree and the peer survives; self-exit marks only
  that session `exited` with the buffer retained; close-window reaps all; three
  `process-hygiene.ps1 -List` runs → **0 unprotected orphan candidates**.
- R-16 PASS — no `infrastructure/rtdb/**` / `infrastructure/otlp/**` in the #2934 diff;
  `telemetry_spans`/`telemetry_logs` live (see the round-3 `## Tests Runs`); both windows'
  consoles clean.
- R-17 PASS — `list_terminal_sessions` = `[]` after the window closed; `sqlite_master` has no
  `%terminal%`/`%run_cli%` table.
