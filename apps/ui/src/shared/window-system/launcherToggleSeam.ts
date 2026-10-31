/**
 * Window-system launcher-toggle seam (Spec #3121, ST-2).
 *
 * The `window.launcher.toggle` verb's OUTCOME is the shipped launcher toggle that lives in
 * `LauncherShell` (`selectCtrlSpaceAction` verdict + `openOverlay`). The surface must run
 * that outcome exactly once when the chord delegates into the host, without re-entering the
 * shared hotkeys registry (whose run is now the delegating override) — an unguarded
 * registry round-trip would recurse host → verb → action → host.
 *
 * `LauncherShell` registers its core toggle here for the shell's mounted lifetime; the
 * surface verb calls it. With no shell mounted the seam reports `false` and the verb is a
 * `noop` (there is no launcher to toggle). Session-scoped callback only — no persistence.
 */

type LauncherToggleHandler = () => void;

let handler: LauncherToggleHandler | null = null;

/** Register (or clear, with `null`) the shipped launcher toggle for this shell's lifetime. */
export function setWindowLauncherToggle(next: LauncherToggleHandler | null): void {
  handler = next;
}

/** Run the shipped launcher toggle; `false` when no launcher shell is mounted. */
export function runWindowLauncherToggle(): boolean {
  if (handler === null) return false;
  handler();
  return true;
}

/** Test-only: drop the registered handler so a suite starts from a clean seam. */
export function resetWindowLauncherToggleForTests(): void {
  handler = null;
}
