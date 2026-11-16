/**
 * Spec #2940 ST-5 — C-5 one-time fixture-record purge (AC4: R-4.1 / R-4.2).
 *
 * WHAT IT DOES
 *   Lists every persisted Terminal record via the shipped
 *   `list_persisted_terminal_sessions` command, deletes each record whose
 *   `workDir` is under the in-repo fixtures root
 *   (`.opencode\tests\terminal\fixtures`) via the shipped
 *   `delete_terminal_session_record`, then re-lists and reports the residue.
 *   Records the developer actually ran are NEVER touched (fixtures-root filter
 *   only). No new IPC command and no backend change is used.
 *
 * HOW TO INVOKE
 *   Paste the single `(async () => { … })()` IIFE below into the MCP tool
 *   `tauri_webview_execute_js` targeting the `terminal` window, e.g.
 *   `tauri_webview_execute_js { window: "terminal", code: <the IIFE> }`.
 *   It is one bare expression, so the tool resolves to its report. Idempotent:
 *   a second run deletes zero records and reports an empty `residue`.
 *
 * SETTINGS RESTORE (BINDING, Architect C-5)
 *   The durable suite teardown ALSO restores the four diagnostic settings keys it
 *   overwrites — `terminal_work_dir`, `terminal_default_cli`,
 *   `terminal_copilot_path`, `terminal_pwsh_path` — to their captured pre-run
 *   values. This one-time purge does not itself write settings, but if the tester
 *   sets `window.__FREDO_FIXTURE_SETTINGS_SNAPSHOT` to the map captured BEFORE
 *   the run (via `get_setting`), the IIFE restores them too. Full detail lives in
 *   `.opencode/tests/terminal/functional.md` → "C-5 teardown / snapshot /
 *   settings-restore" (repeated in the other three suites and
 *   `.opencode/tests/run-cli/regression.md`).
 */

(async () => {
  // Leading-dot in the recorded workDir is irrelevant: the fixtures root is
  // matched as a case-insensitive path substring.
  const FIXTURES_ROOT = String.raw`.opencode\tests\terminal\fixtures`.toLowerCase();
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

  const isFixtureRecord = (record) => {
    const workDir = String((record && record.workDir) || '')
      .replace(/\//g, '\\')
      .toLowerCase();
    return workDir.includes(FIXTURES_ROOT);
  };

  const before = await invoke('list_persisted_terminal_sessions');
  const doomed = before.filter(isFixtureRecord);

  const deleted = [];
  for (const record of doomed) {
    await invoke('delete_terminal_session_record', { sessionId: record.id });
    deleted.push([record.id, record.title, record.workDir]);
  }

  const snapshot = window.__FREDO_FIXTURE_SETTINGS_SNAPSHOT ?? null;
  const settingsRestored = [];
  if (snapshot) {
    for (const [key, value] of Object.entries(snapshot)) {
      await invoke('save_setting', { key, value: value ?? '' });
      settingsRestored.push(key);
    }
  }

  const after = await invoke('list_persisted_terminal_sessions');
  const residue = after.filter(isFixtureRecord).map((record) => record.id);

  return {
    deleted,
    deletedCount: deleted.length,
    remainingIds: after.map((record) => record.id),
    residue,
    settingsRestored,
  };
})()
