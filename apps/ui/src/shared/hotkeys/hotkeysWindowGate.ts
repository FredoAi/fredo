/**
 * Spec #3007 ST-2 — the route/window-based gate for the ONE shared resting
 * hotkeys cluster (`HotkeysCluster`).
 *
 * The cluster (the `hotkeys-input-regime` chip + `hotkeys-keys-discovery`, plus
 * the first-run card) is RESTING chrome. In the `doom` webview
 * (`index.html?view=doom`) the window is the game and nothing else, so the
 * cluster must not render there. This is a WINDOW-scoped decision — not a
 * focus-context one — because the chip is resting (it is not tied to any focus
 * target), which is why it lives here rather than in the terminal focus-context
 * suppression (`focusContext.ts` / `inputRegime.ts`).
 *
 * The gate is PURE: it reads only the query string, defaults to the live
 * `window.location.search`, and is true IFF the `view` param is exactly `doom`.
 * Every other window (including no query at all) is un-suppressed, so the
 * cluster renders byte-identically to today.
 */

/** Query parameter that selects a webview's route (`view=doom|terminal|app`). */
export const HOTKEYS_CLUSTER_SUPPRESSED_VIEW_PARAM = 'view';

/** The `view` value whose webview suppresses the resting hotkeys cluster. */
export const HOTKEYS_CLUSTER_SUPPRESSED_VIEW_VALUE = 'doom';

/**
 * Whether the resting hotkeys cluster is suppressed for the given (or current)
 * query string. Pure; true IFF `view=doom`.
 */
export function isHotkeysClusterSuppressed(search: string = window.location.search): boolean {
  return (
    new URLSearchParams(search).get(HOTKEYS_CLUSTER_SUPPRESSED_VIEW_PARAM) ===
    HOTKEYS_CLUSTER_SUPPRESSED_VIEW_VALUE
  );
}
