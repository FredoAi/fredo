# setup — Functional

> Fredo Setup auto-open removal + launcher tile (Issue #3010). The desktop no longer auto-opens
> the Setup wizard on startup; Fredo Setup is reachable only through explicit user action (the
> new launcher tile, and the existing Settings entry). Maps 1:1 to `.opencode/tmp/3010/triage.md`
> `## QA Expert` F-1..F-8.
>
> **Verification policy: live.** Every PASS carries `telemetry_spans` evidence from the env's own
> PostgreSQL cluster (manifest `ports.pg`); a static-only PASS is a FALSE PASS.
>
> **Binding hook (G-340):** `#fredo-launcher-grid [role="button"][aria-label="Fredo Setup"]` —
> display/accessible name `Fredo Setup`; NO new `data-testid`.
>
> Env: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3010 -EnvId spec3010 -EnvSlot <n>`.
> Plugin-not-installed profile lever (G-301): `-Action Clean -EnvId spec3010` then `Up` (the
> settings store is wiped, so `plugin_installed` is unset — the falsy condition the removed
> effect keyed on). Restart via explicit `Down` then `Up` carrying the same EnvId+EnvSlot (G-328).

## F-1 (R-1 / AC1) — No forced Setup on a fresh boot

- [ ] F-1: Fresh-slate env (settings key `plugin_installed` unset). Boot the desktop. Snapshot the
      DOM immediately, at +1.4 s, and at +5 s (past the deleted 1200 ms timer).
  **Expected:** at EVERY sample, NO `div[role="group"][aria-label="Fredo Setup"]`, NO
      `.fredo-window__surface` titled `Fredo Setup`, and NO `SetupWizard` in the DOM; the
      desktop/launcher renders (`#fredo-launcher-grid` reachable). `telemetry_spans` non-zero with
      a recent timestamp for the env.
  - **Edge:** a real plugin-absent profile (`Test-Path ~\.config\opencode\plugins\fredo.js` false)
    behaves identically (the reader is deleted, so plugin presence is irrelevant — R-5);
    `Ctrl+R` reload re-holds; empty/fresh store boot. No error path.

## F-2 (R-2 / AC2, binding hook) — Exactly one accessible-name launcher tile

- [ ] F-2: Engage the grid (`input[role="searchbox"]` focus / Ctrl+Space). Run
      `document.querySelectorAll('#fredo-launcher-grid [role="button"][aria-label="Fredo Setup"]')`.
  **Expected:** `.length === 1`; the tile is inside `#fredo-launcher-grid[role="grid"]`; NO
      duplicate tile (dedupe by id); the tile is visible and not clipped (its
      `getBoundingClientRect` is fully inside the grid's rect). The G-273 render clauses (appears
      once, no clip, ordering) are owned by ST-2.
  - **Edge:** query filter `setup` matches it; arrow-key nav can reach it (selectable); light AND
    dark render it; stable across reload.

## F-3 (R-2 / AC2) — Activating the tile opens the wizard in a window

- [ ] F-3: Click the F-2 hook tile. Then re-invoke it.
  **Expected:** a Fredo application window opens — `div[role="group"][aria-label="Fredo Setup"]`
      with header title `Fredo Setup`, rendering `SetupWizard` (six `STEPS` cards). Default
      presentation is `same-window` (kernel window — Architect binding); re-invoke focuses/restores
      the SAME window (`.fredo-window__surface` count stays 1).
  - **Edge:** open while another feature window is already open (z-order/focus); keyboard Enter on
    the focused tile; close then re-open.

## F-4 (R-3 / AC3) — Settings → Fredo Setup opens the SAME wizard

- [ ] F-4: Open Settings; click nav id `plugin-setup` (label `Fredo Setup`).
  **Expected:** the `plugin-setup` nav item exists and its content renders `<SetupWizard/>` — the
      SAME component as F-3, same six `STEPS` cards/steps/visuals, rendered not clipped.
  - **Edge:** light + dark; nav starts on Companion then switches; wizard opens with a feature
    window already open.

## F-5 (R-4 / AC4) — No automatic/forced route (continuous negative, G-123)

- [ ] F-5: Booted env, NO explicit open: observe ≥3 s idle (past the removed timer), `Ctrl+R`,
      focus/blur cycles, and drive the paths that used to auto-open (konami/companion mount).
  **Expected:** Setup never opens without user action — no `Fredo Setup` window/surface from any
      timed, reload, or automatic path; the ONLY opens observed are F-3 (tile) and F-4 (Settings).
      `fredo open-app setup` is an explicit user-initiated route only (Architect Discussion),
      never automatic.
  - **Edge:** plugin-not-installed profile (as F-1); rapid reloads; 10 s idle. No error path.

## F-6 (R-5 / AC5) — `plugin_installed` zero readers; no first-run gate regressed

- [ ] F-6: (static, non-AC pin) `rg "plugin_installed" apps/ui/src`; inspect `Home.tsx` imports
      and effects. (live) Confirm desktop startup + Companion/setup readiness behave as before.
  **Expected:** (static) ZERO `plugin_installed` hits under `apps/ui/src`; `Home.tsx` carries no
      `setupFeature`/`settingsService` import and no auto-open effect (ST-1). (live) desktop startup
      and Companion readiness are unchanged.
  - **Edge:** key absent elsewhere in `apps/ui/src`; no replacement gate/flag introduced.

## F-7 (E2E, mandatory) — End-to-end through the running desktop app (PG-only boot)

- [ ] F-7: Boot the app against its Postgres-backed instance
      (`-Action Up -Spec 3010 -EnvId spec3010 -EnvSlot <n>`; no SQLite). (a) observe boot past
      ~1.2 s with the plugin-not-installed profile (fresh-slate settings reset); (b) activate the
      tile AND Settings→Fredo Setup; (c) open Mission Monitor and confirm live sessions render.
  **Expected:** (a) desktop/launcher shows and NO Setup window auto-opens at any sample (incl.
      +1.4 s / +5 s); (b) the tile opens the wizard window AND Settings→`plugin-setup` opens the
      same wizard; (c) Mission Monitor renders its live session surface (the boot path is not broken
      by the effect removal). Each leg carries `telemetry_spans` + screenshot + console-clean.
  - **Edge:** boot twice; sample multiple timestamps; Mission Monitor with zero sessions renders its
    empty state (no crash). No error path.

## F-8 (Non-functional) — Accessibility / theme / console

- [ ] F-8: Keyboard-navigate the grid to the tile and open it; toggle light/dark; read the console
      across boot + every open.
  **Expected:** tile reachable by grid keyboard nav AND query filter; accessible name exactly
      `Fredo Setup`; tile + wizard window render token-native in light AND dark (no hardcoded
      color, no clip); console clean (no `Error:`/`Uncaught`/`Maximum update depth exceeded`).
  - **Edge:** long label ellipsis; reduced-motion; repeated open/close churn.
