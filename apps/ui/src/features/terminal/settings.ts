import { settingsService } from '../settings';

/**
 * Terminal settings keys.
 *
 * `WORK_DIR_KEY` — the working directory new terminal sessions default to.
 * `DEFAULT_CLI_KEY` — the CLI a newly added session is preselected to (the
 * constant is defined here so the multi-session work can consume it; its
 * Settings control lands with that work and is NOT rendered yet).
 */
export const WORK_DIR_KEY = 'terminal_work_dir';
export const DEFAULT_CLI_KEY = 'terminal_default_cli';

/**
 * The ONE allowed legacy read (AC1 exception): the pre-rename working-directory
 * key. It is shadowed by a one-way migration and is never rewritten or deleted.
 */
const OLD_WORK_DIR_KEY = 'run_cli_work_dir';

// Module-scoped idempotency flag: survives component remount and window
// reopen, so the migration runs at most once per app session (AGENTS.md
// persistence rule — a `useRef` would reset on every mount and re-run the read).
let _migrated = false;

/**
 * One-way, idempotent migration of the pre-rename working directory onto the
 * Terminal key. Runs through `settingsService`, so it covers BOTH stores (the
 * SQLite `get_setting`/`save_setting` pair AND the dev-server `localStorage`
 * fallback). `terminal_work_dir` always wins: when it holds a value the legacy
 * key is not even read; otherwise the legacy value is COPIED across and the
 * legacy key is left untouched.
 */
export async function ensureTerminalSettingsMigrated(): Promise<void> {
  if (_migrated) return;
  const current = await settingsService.get<string>(WORK_DIR_KEY, '');
  if (current) {
    _migrated = true;
    return;
  }
  const legacy = await settingsService.get<string>(OLD_WORK_DIR_KEY, '');
  if (legacy) await settingsService.set(WORK_DIR_KEY, legacy);
  _migrated = true;
}
