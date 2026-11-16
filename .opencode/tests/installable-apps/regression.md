# installable-apps — Regression Tests

The **must-not-change** baseline for Spec #3147. Installing applications introduces a new window
class and (in ST-1) flips Tauri's app-manifest ACL gate on, which is the single most dangerous
change in the spec: a mistake there denies commands to *every* existing window. Each case below is a
non-goal of #3147 and must read identically on the spec tip.

> **Cross-suite links — run these too when the named surface changes:**
>
> - `webview-security-boundary/regression.md` — R-1 (capability `windows` arrays), R-2 (the seven
>   `default.json` grants), R-3 (window open/close via `core:window:*`), R-9/R-10 (documents load,
>   no CSP refusals). Any change under `capabilities/` runs that suite.
> - `window-manager/regression` + `.opencode/tests/window-manager/functional.md` F-3/F-8 — built-in
>   window open/close lifecycle. `.opencode/tests/application-data/` for the declared/canonical
>   store rows. `.opencode/tests/terminal/` for the Terminal host label (`terminal`).
> - `settings/functional.md` — the Settings nav surface the new pane is added to.
> - `launcher/functional.md` — the launcher grid / open-apps row the new sibling section sits beside.
> - `theme-contract` + `theming` — the token→CSS-var contract the theme transport reads.

_Evidence convention: quote the `file:line` text, the grep count, the unit-test name, or the exit
code. "No change" without a quoted artifact is not evidence._

## R-1 — Capability files are unchanged

- [ ] **R-1.1** — `apps/tauri/src-tauri/capabilities/default.json` still reads
  `"windows": ["main", "terminal", "doom", "app-*"]` and `"platforms": ["linux", "macOS", "windows"]`.
  - EXPECT: both arrays byte-equal to the pre-spec text; the seven permissions (`core:default`,
    `core:event:allow-listen`, `core:event:allow-emit`, `core:window:allow-start-dragging`,
    `core:window:allow-set-title`, `core:window:allow-create`, `core:window:allow-close`) unchanged
    and no per-command grant added for a built-in.
  - EDGE: a new entry for `installed-*` in `windows` is a FAIL of R-2.4 **and** of AC-2 — the
    refusal depends on the non-match.

- [ ] **R-1.2** — `capabilities/mcp-bridge-dev.json` still grants only `mcp-bridge:default` to
  `["main","terminal","doom","app-*"]`.
  - EXPECT: file byte-identical; the dev-only bridge capability surface unchanged.
  - EDGE: an `installed-*` entry here would hand the debug bridge to an untrusted document — the
    worst possible regression in this spec.

- [ ] **R-1.3** — the capability **directory** still contains exactly the pre-spec files (plus
  nothing that widens reach): enumerate the directory and list every filename.
  - EXPECT: no file whose `windows` list includes `*`, `installed-*`, or a bare `installed-` prefix.
  - EDGE: `permissions/app/default.toml` is a permission SET (referenced from a capability), not a
    capability — its presence is expected and does not widen any window.

## R-2 — Every built-in window keeps every command it has today (R-2.3)

- [ ] **R-2.1 — full command surface, from one window.** With only the `main` window open, invoke,
  via `tauri_ipc_execute_command` / `execute_js` `__TAURI_INTERNALS__.invoke`, the commands the
  shipped UI calls today: `get_control_setting`, `save_control_setting`, `get_setting`,
  `save_setting`, `stream_health`, `app_window_presentation`-backed `open_app_window`.
  - EXPECT: every call resolves (no `not allowed`/ACL error). Quote each result or its typed `Err`.
  - EDGE: an ACL denial on ANY of these is the ST-1 regression — the `AppManifest::commands(...)`
    list or `permissions/app/default.toml` is incomplete. Report the exact command name.

- [ ] **R-2.2 — the `app-*` window class still works.** Open Database Client (or any registered grid
  app) from the launcher; it opens as `app-<id>` (or renders in-window per the persisted
  presentation default `same-window`).
  - EXPECT: the window renders its content; the webview is interactive; `core:window:allow-create` /
    `allow-close` still function; no capability-denied error in the console.
  - EDGE: with the persisted presentation set to `new-window`, the `app-<id>` label still matches
    `app-*` — verify with `tauri_manage_window action="list"`.

- [ ] **R-2.3 — bespoke hosts keep their fixed labels.** Terminal and Doom open as `terminal` /
  `doom` (not `app-terminal`), per `app_window_label` (`infrastructure/app_window.rs:78-84`).
  - EXPECT: window labels read exactly `terminal` / `doom`; both match a capability `windows` entry.
  - EDGE: this function must be **untouched** by this spec — ST-4's non-goal forbids editing
    `infrastructure/app_window.rs` or `open_app_window`.

- [ ] **R-2.4 — the Terminal command surface.** `open_terminal_window` + `spawn_terminal_session` +
  `list_terminal_sessions` still succeed from `main`/`terminal`.
  - EXPECT: a session appears in the list; PTY I/O still works; no ACL denial.
  - EDGE: a Terminal spawn failure is the highest-value ST-1 regression (its command list is long).
    Cross-run `.opencode/tests/terminal/`.

## R-3 — The pinned built-in registry is untouched

- [ ] **R-3.1** — `pnpm --filter @fredo/ui test:run src/applications/__tests__/retainedApplicationSet.test.ts`
  ⇒ exit `0`; all three cases green.
  - EXPECT: the pinned map is exactly `wireframe, terminal, mission-monitor, database-client,
    theming (hidden), setup, settings, dev-mode (hidden)`; the test file is **unmodified**
    (`git diff --stat origin/main...HEAD -- apps/ui/src/applications/__tests__/` empty).
  - EDGE: editing this test to accommodate installed apps is a **plan defect** (ST-6 non-goal) —
    FAIL the row and report it, never accept "test updated".

- [ ] **R-3.2** — installed apps never enter the built-in registry.
  - EXPECT: grep `apps/ui/src/shared/installed-apps/` for `registerApplication(` ⇒ **0** matches;
    grep for `from '../../applications/` (a cross-import into the registry tree) ⇒ 0; and
    `getApplications()` (host `execute_js`) returns the same ids before and after installing an app.
  - EDGE: the installed-apps store lives under `shared/`, not `applications/`, because
    `allApplications.ts:3` eagerly globs `./*/index.ts` — a new `applications/installed-apps/`
    directory would be auto-imported into the host bundle. Verify the directory does not exist.

- [ ] **R-3.3 — the launcher grid is unchanged.** With installed apps present, the `| APPLICATIONS`
  grid renders exactly the showable built-in tiles (`SHOWABLE_FEATURES`), and the installed-apps
  section is a SEPARATE sibling (`[data-testid="launcher-installed-apps-section"]`).
  - EXPECT: grid tile count/ids unchanged from the pre-install state; installed apps appear only in
    their own section; `Home.tsx` is not edited to add applications (grep `Home.tsx` for
    `installed` ⇒ 0 matches outside the launcher render site).
  - EDGE: a tile-count change after installing an app is a FAIL of the registry-separation rule.

## R-4 — Settings surface behaviour unchanged

- [ ] **R-4.1** — the Settings sidebar still renders its static sections and the feature sections
  built from the registry: Companion, Appearance, Fredo Setup, Telemetry, Apps, Ingest, Database,
  Layout (+ the `Applications` group for `hasSettings` apps).
  - EXPECT: every pre-spec nav item still present with its existing `data-testid`
    (`settings-nav-apps`, `settings-nav-ingest`, `settings-nav-postgres`, `settings-nav-layout`)
    and each section still renders its content on click.
  - EDGE: a retired/renamed section is a FAIL — the installed-apps pane is an ADDITION, never a
    replacement. Do **not** target `ProfileSettingsModal.tsx` / `SettingsPanel.tsx` (retired by
    #2868 — they must not exist).

- [ ] **R-4.2 — the Appearance pane still owns the theme controls.** `select[aria-label="Theme
  presets"]` and the per-token colour inputs (`aria-label="Primary color"` …) still render and
  still change the host's CSS vars.
  - EXPECT: changing the preset still repaints the host shell; `--body-bg` on
    `document.documentElement` changes to the preset's value.
  - EDGE: a theme change that no longer reaches the host is a FAIL (the new capture must be
    additive, ST-5's non-goal forbids re-styling the host).

- [ ] **R-4.3** — the three UI/UX-added hooks render in exactly ONE surface each and add no host behaviour: `installed-apps-empty` (pane, when the registry is genuinely empty), `installed-apps-limitations` (pane footer, always visible), `launcher-installed-app-error` (launcher, only on a refused open).
  - EXPECT: each appears only in its named surface; none is a tab stop; none exists at all when its trigger state is absent (a zero-installed boot paints no installed-app surface — R-5.1's discriminator depends on it).
  - EDGE: a hook rendered by two components is a FAIL of the one-owner rule (G-266). Cross-run `.opencode/tests/settings/functional.md` and `.opencode/tests/launcher/functional.md`.

## R-5 — Windows and the window engine are untouched

- [ ] **R-5.1** — `infrastructure/app_window.rs` and `open_app_window` are unmodified by this spec
  (`git diff --stat origin/main...HEAD -- apps/tauri/src-tauri/src/infrastructure/app_window.rs`
  empty).
  - EXPECT: empty diff; `GENERIC_APP_WINDOW_LABEL_PREFIX = "app-"` still the built-in generic prefix.
  - EDGE: the installed-app builder is a SEPARATE path (`WebviewUrl::External`), never a branch
    inside this file.

- [ ] **R-5.2** — the built-in window lifecycle still behaves: open → focus/raise → minimize →
  restore → close for a feature app.
  - EXPECT: one window per feature id on repeated opens; close removes it; no `Maximum update depth
    exceeded` in the console after the cycle.
  - EDGE: cross-run `.opencode/tests/window-manager/functional.md` F-3/F-8 for the full matrix.

## R-6 — Config and packaging are unchanged

- [ ] **R-6.1** — `apps/tauri/src-tauri/tauri.conf.json` is unmodified: `app.security.csp`,
  `app.security.devCsp`, `app.withGlobalTauri: false`, `bundle.externalBin: []`.
  - EXPECT: byte-identical for those keys (`git diff --stat` empty for the file).
  - EDGE: the installed document's CSP is authored by the scheme handler — a global CSP edit is a
    FAIL of N-1 (it also belongs to `webview-security-boundary`).

- [ ] **R-6.2** — no new capability grant and no new command per application.
  - EXPECT: the installed-app command set is exactly `installed_app_install`, `installed_apps_list`,
    `installed_app_open`, `installed_app_close`, `installed_apps_push_theme`; installing an app adds
    **no** command and no capability (grep `lib.rs` generate_handler for `installed_app` ⇒ those five
    names only).
  - EDGE: an app-specific command is a FAIL of the "no new backend code per application" constraint;
    #3146's allowlist/facade is out of scope — its absence is **not** a FAIL here.

- [ ] **R-6.3 — build gate.** `pnpm --filter @fredo/ui build` ⇒ exit `0` (no TS errors);
  `cargo check --locked` in `apps/tauri/src-tauri` ⇒ exit `0`, zero `warning:` lines;
  `pnpm --filter @fredo/ui test:run` ⇒ exit `0`.
  - EXPECT: all three green; `permissions/autogenerated/` is gitignored (the build writes it into the
    source tree — a tracked generated tree is a hygiene FAIL).
  - EDGE: `run-exitcode.ps1 -Command "<cmd>"` for the `EXITCODE=` values; a Rust test leg needs the
    env `Down` (the running binary locks the target).

## R-7 — Prior-spec boundaries that must not be re-opened

- [ ] **R-7.1** — `webview-security-boundary` F-1/F-3/F-6/F-9/F-10 still read the same: no shell
  capability, the MCP bridge is dev-only, `shell:allow-open` absent, CSP + `withGlobalTauri: false`,
  zero `__TAURI__` in product source (#3077/#3078 baseline).
  - EXPECT: identical results to their last recorded evidence; #3147 adds no capability and no CSP
    change. `__TAURI_INTERNALS__` remains the IPC handle (ST-1 must not add a global).
  - EDGE: a `withGlobalTauri: true` change (however tempting for the child document) is a FAIL of
    this row — the child uses `__TAURI_INTERNALS__` via the served doc, not a global handle.

- [ ] **R-7.2** — Theme contract unchanged: every Chakra colour token still resolves to a `var(--…)`
  (`apps/ui/src/app/theme/system.ts`), and `SEMANTIC_TOKENS` (`app/theme/contract/tokens.ts`) is not
  re-enumerated on the frontend by the theme capture (ST-5 non-goal — the capture reads
  `getComputedStyle`).
  - EXPECT: grep the new capture module for `SEMANTIC_TOKENS` ⇒ 0 matches; the host's rendered shell
    is visually unchanged after the capture call site is added.
  - EDGE: a second enumeration that drifts from the token registry is a FAIL even if it renders.

_Evidence convention: quote the artifact. A build/unit gate quotes `EXITCODE=`; a static case quotes
the file:line and the assertion; a live case quotes the observed value._
