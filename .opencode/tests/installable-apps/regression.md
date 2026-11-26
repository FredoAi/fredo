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
> - **`navigation-prose-retirement/regression.md`** — run it with the **#3145** rows too: its **PR-5**
>   is re-cut in place by #3145 (`functional.md` F-8.18) because it asserted "no `docs/`-level
>   authoring document exists", which the authoring documentation falsifies. That ONE row is expected
>   to change; no other row in it may.

_Evidence convention: quote the `file:line` text, the grep count, the unit-test name, or the exit
code. "No change" without a quoted artifact is not evidence._

## R-1 — The pre-spec capability files are unchanged, and no capability widens reach

- [ ] **R-1.1** — `apps/tauri/src-tauri/capabilities/default.json` still reads
  `"windows": ["main", "terminal", "doom", "app-*"]` and `"platforms": ["linux", "macOS", "windows"]`.
  - EXPECT: both arrays byte-equal to the pre-spec text; the seven permissions (`core:default`,
    `core:event:allow-listen`, `core:event:allow-emit`, `core:window:allow-start-dragging`,
    `core:window:allow-set-title`, `core:window:allow-create`, `core:window:allow-close`) unchanged,
    and `default.json` itself still grants **no per-command entry for a built-in** (this is scoped to
    this FILE: the app-command surface legitimately lives in `capabilities/app-commands.json`, which
    R-1.3 governs — its per-command grant to the built-in class is EXPECTED, never a FAIL here).
  - EDGE: **UPDATED BY #3146 (this clause used to read "a new entry for `installed-*` in `windows` is a
    FAIL").** `default.json` still carries NO `installed-*` entry — that remains a hard FAIL here.
    But the *reason* has moved: the installed tier's one grant lives in its own capability file
    (`capabilities/installed-app-commands.json`, `windows: ["installed-*"]`,
    `permissions: ["allow-installed-app-invoke"]`), and `default.json` is where the installed
    namespace must NEVER appear, because it carries `core:*`. An `installed-*` label appearing in
    `default.json` (or `mcp-bridge-dev.json`) hands the **privileged** command/core surface to an
    untrusted document — still a total FAIL of AC-2 and of R-1.1/R-1.2, and now with a sharper
    reason: it would be the SECOND matching capability file (F-2.5 expects exactly one).

- [ ] **R-1.2** — `capabilities/mcp-bridge-dev.json` still grants only `mcp-bridge:default` to
  `["main","terminal","doom","app-*"]`.
  - EXPECT: file byte-identical; the dev-only bridge capability surface unchanged.
  - EDGE: an `installed-*` entry here would hand the debug bridge to an untrusted document — the
    worst possible regression in this spec, and (since #3146) also the SECOND capability matching the
    installed namespace, which F-2.5 pins at exactly one.

- [ ] **R-1.3** — **the capability directory's reach is exactly one installed-tier grant and nothing
  else** (INVERTED IN PLACE by #3146 — the row keeps its id and its *reach* property; the expected
  value flips from "zero capability files match `installed-*`" to "exactly one matches, granting
  exactly one permission").
  - **INSTRUMENT — a parsed-JSON matcher over every file, never a raw token grep (G-430).** Enumerate
    `apps/tauri/src-tauri/capabilities/` with a **directory listing** (never a Glob — G-024/G-105) and
    put in the evidence **every filename present and every file's full `windows` array**. The file
    COUNT is **not** the assertion — it is enumerated at test time (four at the #3146 tip; a later
    legitimate addition must not fail this row); the reach property is the assertion. For each file,
    PARSE the JSON and glob-match the probe label against `windows` **and** `webviews`. A raw grep for
    `installed-` returns ≥1 hit on a correct tree by design (`installed-app-commands.json` names the
    namespace), so a token predicate would either redden wrongly or be widened until it proved
    nothing.
  - EXPECT (reach — the binding, hard-FAIL assertion): **exactly ONE** capability file has a
    `windows`/`webviews` entry that matches an `installed-<probe>` label; quote its filename and its
    full `windows` + `permissions` arrays; its `windows` is exactly `["installed-*"]` and its
    `permissions` is exactly `["allow-installed-app-invoke"]`. **Every other** file's entries fail to
    match. Quote the matcher's result for EVERY file beside that file's `windows` array.
  - EXPECT (no widening — a separate, still strict assertion): every **other** capability's `windows`
    array is exactly `["main","terminal","doom","app-*"]` **or a strict subset of those four labels**,
    and the same holds for any `webviews` array. No capability outside the installed tier targets a
    window/webview pattern outside that pre-existing set. **A capability whose whole purpose is to
    grant the app-manifest `default` permission set (`permissions/app/default.toml`) to exactly those
    four pre-existing built-in patterns is EXPECTED and is NOT a violation** — that is
    `capabilities/app-commands.json`. A capability that ADDS a window pattern, or that grants anything
    beyond the one permission to `installed-*`, IS a FAIL.
  - EXPECT (pre-spec files untouched — the SEPARATE assertion, not the enumeration): `default.json`
    and `mcp-bridge-dev.json` are each **byte-identical to their pre-spec text**. Quote
    `git diff --stat origin/main...HEAD` scoped to those two paths as **empty output** (R-1.1 / R-1.2
    pin their content in full, so an empty diff here is the corroborating artifact, not the proof).
  - EXPECT (every file's reach is READABLE from the file): each capability file MUST carry an
    explicit, non-empty `windows` array (or, if it targets webviews instead, a non-empty `webviews`
    array) — quote it. A capability whose window reach cannot be read off its own declaration cannot
    be shown to exclude anything, so record an absent or empty `windows`/`webviews` as a **FAIL of
    this row** and quote the whole file, rather than assuming the omitted key means "no windows".
  - NON-VACUITY CONTROLS (mandatory, same round — BOTH): (a) the SAME matcher applied to the sample
    label `app-terminal` **MATCHES** `app-*` (a matcher that reports "no match" for every label is
    matching nothing and cannot witness an absence or a cardinality); (b) `installed-app-terminal`
    matches `installed-*` and **does NOT** match `app-*` (the tier separation — #3146's new control).
  - EDGE: a capability that reaches an `installed-*` label through `webviews` instead of `windows` is
    the same reach and counts as the one match (record which key carried it). `permissions/app/
    default.toml` is a permission SET (referenced from a capability), not a capability — its presence
    is expected and does not widen any window. A capability naming a SPECIFIC installed id
    (`installed-qa3146-app-a`) instead of the `installed-*` family is a FAIL of "no per-application
    capability file" (R-8.3). The committed guard
    `.opencode/scripts/inspect-webview-config.ps1` must implement this positive form; quote its
    `CHECK` line and `Detail` **verbatim as shipped** (G-419), and quote `ExpectedCapabilities`, which
    must now include `installed-app-commands.json`.

## R-2 — Every built-in window keeps every command it has today (R-2.3)

> **The mechanism, named explicitly (it changed in ST-1 and this is the regression it can break).**
> ST-1 turns Tauri's IPC authority gate ON: `build.rs` now registers
> `tauri_build::AppManifest::commands(COMMAND_MANIFEST)`, so from that commit **a registered command
> reaches a window only if a capability grants it** — registration alone is no longer access. Three
> things must all hold, and each one alone is enough to silently deny every shipped window:
> **(1)** the command is listed in `COMMAND_MANIFEST` (`src/runtime/command_manifest.rs`) — an absent
> entry gets no autogenerated permission at all; **(2)** `permissions/app/default.toml` grants that
> command (`allow-<command>`); **(3)** `capabilities/app-commands.json` grants the app-manifest
> `default` permission set to the built-in window class `["main","terminal","doom","app-*"]` — the
> component the pre-ST-1 plan did not name, and without it the permission set is INERT (nothing
> references it, so nothing is granted). So a denial in R-2 is no longer only a "missing list entry":
> read all three — which one is missing is what R-2.1's EDGE asks you to report. `capabilities/
> default.json` and `mcp-bridge-dev.json` are unaffected in this respect (they grant `core:*` and the
> dev bridge, not the app-command surface).

- [ ] **R-2.1 — full command surface, from one window.** With only the `main` window open, invoke,
  via `tauri_ipc_execute_command` / `execute_js` `__TAURI_INTERNALS__.invoke`, the commands the
  shipped UI calls today: `get_control_setting`, `save_control_setting`, `get_setting`,
  `save_setting`, `stream_health`, `app_window_presentation`-backed `open_app_window`.
  - EXPECT: every call resolves (no `not allowed`/ACL error). Quote each result or its typed `Err`.
  - EDGE: an ACL denial on ANY of these is the ST-1 regression — report WHICH of the three links is
    broken: the command missing from `COMMAND_MANIFEST`, missing from `permissions/app/default.toml`,
    or `capabilities/app-commands.json` not granting `default` to the `main` label. Name the exact
    command and the exact missing link. A denial is never "the gate is just strict now".

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

- [ ] **R-6.2** — no new capability grant **per installed application**, and no new command per application. (INVERTED IN PLACE by #3146: the shipped `installed-` grep of 0 is now a parsed-JSON cardinality of exactly 1, and `installed_app_invoke` is the one legitimate addition.)
  - EXPECT: the installed-app command set is `installed_app_install`, `installed_apps_list`, `installed_app_open`, `installed_app_close`, `installed_apps_push_theme` **plus #3146's `installed_app_invoke`, `installed_app_consent_grant`, `installed_app_consent_revoke`** and nothing else — grep `lib.rs`'s `generate_handler!` for `installed_app` and quote the resulting name list. `installed_app_invoke` is the only new *app-dispatch* command; the two consent commands are **built-in-tier only** (an installed document cannot reach them — F-7.9/F-7.10).
  - EXPECT: installing an application adds **no command and no capability**. The assertion is a **parsed-JSON matcher** (never a raw `installed-` grep — the shipped `installed-app-commands.json` names the namespace by design, G-430): exactly ONE capability file matches an `installed-<probe>` label before installing and exactly ONE after, with the same filename, the same `windows` and the same `permissions`. Quote both readings.
  - EDGE: an app-specific command, or a capability file minted per installed id, is a FAIL of the "no new backend code per installed application" constraint. The installed-tier capability's `windows` MUST be the `installed-*` family, never a literal id. **#3146's dispatcher is IN scope now** — the old note that it was "out of scope / its absence is not a FAIL" is superseded: `installed_app_invoke` must exist, must be granted to the built-in set through `permissions/app/default.toml`, and must be the ONLY permission in `capabilities/installed-app-commands.json` (F-2.5, F-7.4).

- [ ] **R-6.3 — build gate.** `pnpm --filter @fredo/ui build` ⇒ exit `0` (no TS errors);
  `cargo check --locked` in `apps/tauri/src-tauri` ⇒ exit `0`, zero `warning:` lines;
  `pnpm --filter @fredo/ui test:run` ⇒ exit `0`.
  - EXPECT: all three green; `permissions/autogenerated/` is gitignored (the build writes it into the
    source tree — a tracked generated tree is a hygiene FAIL).
  - EDGE: `run-exitcode.ps1 -Command "<cmd>"` for the `EXITCODE=` values; a Rust test leg needs the
    env `Down` (the running binary locks the target).

## R-7 — Prior-spec boundaries that must not be re-opened

- [ ] **R-7.1** — `webview-security-boundary` F-6/F-9/F-10 still read the same: no shell capability,
  the MCP bridge is dev-only, `shell:allow-open` absent, CSP + `withGlobalTauri: false`, zero
  `__TAURI__` in product source (#3077/#3078 baseline). Those are the PROPERTIES that must not
  regress, and each is a hard FAIL if it moves.
  - **WHAT #3147 + #3146 ADD, in one sentence.** No CSP change and no permissive grant: two capability
    files now exist beyond the original pair — `capabilities/app-commands.json` (the app-manifest
    `default` permission set to the four pre-existing BUILT-IN window patterns only) and
    `capabilities/installed-app-commands.json` (the INSTALLED tier: `windows: ["installed-*"]`,
    `permissions: ["allow-installed-app-invoke"]`, no `core:*`, nothing else). Neither adds a privilege
    class the product already lacked: no shell, no bridge, no new command family for the built-in
    tier. Neither reaches the other tier (R-1.3 / F-2.5 / F-2.6 assert the reach property in both
    directions). `__TAURI_INTERNALS__` remains the IPC handle — no global handle is added (the child's
    `__FREDO_INSTALLED__.invoke` is a host-authored function on the document, not `withGlobalTauri`).
  - **KNOWN COMPANION-SUITE DRIFT (report it; do not absorb it).** `webview-security-boundary` also
    carries literal file-COUNT clauses — F-1 ("exactly `default.json` + `mcp-bridge-dev.json`"), F-3
    ("the generated manifest lists exactly `default` + `mcp-bridge-dev`") and R-11 (`gen/schemas/
    capabilities.json` "contains exactly `default` + `mcp-bridge-dev`") — which are now FALSE because
    **two** capabilities legitimately exist beyond that pair (`app-commands.json` from #3147 and
    `installed-app-commands.json` from #3146). Those clauses are in a suite this spec is not editing,
    so when the cross-suite run shows them failing, record that as **companion-suite count drift in
    the verdict** and keep the PROPERTY checks (`capabilities.all.no-shell-exec`,
    `capabilities.bridge.identifier` / `capabilities.bridge.permissions`, the debug-assertions gate,
    CSP, `withGlobalTauri: false`, zero `__TAURI__`) as the gate. The drift is a suite-ownership item
    for the Orchestrator; the security properties are not negotiable and any of them moving IS a FAIL
    of this row.
  - EDGE: a `withGlobalTauri: true` change (however tempting for the child document) is a FAIL of
    this row — the child uses `__TAURI_INTERNALS__` via the served doc, not a global handle. ANY
    capability, beyond the one ST-1 adds, that widens a window class is a FAIL of R-1.3, and a
    shell/bridge grant added to the new capability is a FAIL here.

- [ ] **R-7.2** — Theme contract unchanged: every Chakra colour token still resolves to a `var(--…)`
  (`apps/ui/src/app/theme/system.ts`), and `SEMANTIC_TOKENS` (`app/theme/contract/tokens.ts`) is not
  re-enumerated on the frontend by the theme capture (ST-5 non-goal — the capture reads
  `getComputedStyle`).
  - EXPECT: grep the new capture module for `SEMANTIC_TOKENS` ⇒ 0 matches; the host's rendered shell
    is visually unchanged after the capture call site is added.
  - EDGE: a second enumeration that drifts from the token registry is a FAIL even if it renders.

## R-8 — The #3146 authority boundary must not regress the two tiers it sits between

> These rows are the "must not change" counterpart of `functional.md`'s AC-6 group. #3146 turns the
> shipped *"installed windows reach nothing"* invariant into *"installed windows reach exactly one
> command, granted from exactly one capability"* — a **tighter** statement that is easier to widen by
> accident. Each row below names the widening it would catch.
>
> **One exception to "must not change", stated up front: R-8.1.** The declared-table insert path (W-3)
> lands in the SHARED write body, so "the built-in tier is not reduced" cannot be asserted as "that file
> is byte-identical" any more — an empty-diff clause would fail a correct build. R-8.1 asserts the
> property instead: the diff is **confined** to the write path, every removed line is justified, the
> write contract is unchanged from `main` except for the intended insert, and both directions are
> failable. R-8.2…R-8.6 are unchanged "must not change" rows.

- [ ] **R-8.1 — the built-in tier is NOT reduced (re-cut: the shared write body gains the INSERT path
  and nothing else in it moves).**
  > **Why this row no longer asserts an "empty diff".** W-3 lands the declared-table insert path
  > *inside* `apps/tauri/src-tauri/src/infrastructure/application_data/commands.rs`: `write()` returns
  > `record_missing_error` when the named key is absent (`commands.rs:726-728` and `762-764`), so the
  > file MUST change for a write to a new key to create a row. An "empty diff" clause would therefore
  > fail a correct build — it asserted a shape the fix contradicts, not the property this row exists
  > for. The row now binds the diff's **shape** (confined, every removed line justified) plus the write
  > contract's **observable behaviour driven from `main`**, which is what "the built-in tier is not
  > reduced" actually means, and it binds BOTH directions (see EDGE).
  - **EXPECT A — the diff is CONFINED, not empty.** Quote `git diff --stat origin/main...HEAD --
    apps/tauri/src-tauri/src/infrastructure/application_data/commands.rs` and `git diff -U3
    origin/main...HEAD -- <same path>`, including **every** `@@` hunk header with the function its
    context line names. Every hunk must sit inside `write()`, a helper `write()` newly adds,
    `record_missing_error()`, or that file's `#[cfg(test)]` module. A hunk touching `read()`, `watch()`,
    `unwatch()`, `delete()`, `declare()`, `resolve_declaration()`, `guard_application_write()`,
    `key_map()`, `diff_fields()`, `normalize_row()`, `bump_and_notify()`, or the
    `ApplicationDataWriteResult` field list is a **FAIL — quote the hunk.**
  - **EXPECT B — every removed line is justified.** Enumerate each `-` line of that diff. A removed
    `#[test]`, `assert`, match arm or branch is a FAIL unless the same hunk replaces it with an
    equivalent-or-stronger assertion (quote both sides). A removed `fn` other than a signature change
    *inside* `write()` is a FAIL.
  - **EXPECT C — the write contract, driven from `main`, is unchanged EXCEPT for the insert.** Drive
    the built-in tier on a built-in declared table and quote every result: (a) existing key + a changed
    value ⇒ `updated === 1` and the next read shows the new value; (b) existing key + the IDENTICAL
    value ⇒ `updated === 0`, no version bump, no notification (the documented one-diff rule,
    `commands.rs:183-193`); (c) an EMPTY `set` ⇒ the named error `… carries an empty set` (guard
    unchanged); (d) a real change advances `_rowVersion` by exactly `1` and re-stamps `_updatedAt`
    (quote both, before/after); (e) a read still returns the ordinary `{version, rows, retention}`
    shape.
  - **EXPECT C′ — THE INTENDED CHANGE, stated as intended and quoted as the failability control.** A
    write naming a key that does **not** exist now **INSERTS**: record its `updated`, then a read with
    `where:[{field:"<pk>", eq:<the key>}]` returns **exactly one row**. On the pre-W-3 body this same
    call is **REJECTED** with `record […] does not exist in application '…' table '…'` — quote that
    detail from the pre-change comparison (or from a build where it still appears) and FAIL C′. This
    leg is why EXPECT A can no longer be "empty", and it is what proves the insert path landed.
    F-7.36 (`functional.md`) owns the same observable from the **installed** tier.
  - **EXPECT D — not vacuous, and the tier below stays reachable.** Every `R-2.x` built-in command
    still resolves from `main` (cross-run `R-2.1`…`R-2.4` above), **and** a built-in
    `application_data_read` on an installed app's **declared** table still succeeds and returns the
    ordinary `{version, rows, retention}` shape — and where the round produced an installed-tier write
    (F-7.36 / F-7.12 / P-1 in `functional.md`), that exact row comes back (tier 1 takes the id from the
    payload by design). Quote both; if no installed-tier write was made this round, say so instead of
    quoting an empty pair as equality (G-469).
  - **EDGE (both directions — an "empty or tiny diff" is no longer a pass).** A diff that rewrites
    `delete()` "for symmetry", adds a second result field, or relaxes an existing assertion is a FAIL
    even with every row above green — tier 1 is the surface every shipped application depends on. A
    write that reports `updated: 1` for an identical value is a FAIL of the one diff rule. **And an
    EMPTY `commands.rs` diff is a FAIL too**: the plan binds W-3 to that file, so no hunk here means the
    insert path did not land — report the deviation (and the file that carries it, if any) rather than
    scoring EXPECT A green; conversely C′ passing while A reads "empty" means the two readings describe
    different trees — record both and FAIL the row on the contradiction.

- [ ] **R-8.2 — two SEPARATE refusal vocabularies; neither grows into the other.** Read
  `src/applications/installed_apps/mod.rs` (`InstalledAppRefusalCode`) and its unit pin, plus the new
  authority vocabulary.
  - EXPECT: the installer vocabulary is **exactly 22** codes — quote the committed pin's assertion and
    its count; the authority vocabulary is a **separate six** (`action_not_declared`,
    `action_not_grantable`, `consent_required`, `scope_denied`, `caller_unknown`, `app_not_installed`);
    the two types are distinct (no authority code is smuggled into `InstalledAppRefusalCode`, and the
    frontend mirrors stay distinct: `INSTALL_REFUSAL_COPY` vs `CAPABILITY_REFUSAL_COPY`).
  - EDGE: a 23rd installer code added to carry an authority refusal is a **plan defect** — report it,
    never accept it as "the natural place". The consent commands legitimately reuse the FROZEN
    vocabulary (`manifest_invalid_field` with `field: "capability"`, `id_not_installed`) — that is
    reuse, not growth; F-7.21 asserts it.

- [ ] **R-8.3 — the child document's transport is unchanged.** `apps/tauri/src-tauri/tauri.conf.json`
  is unmodified (`app.security.csp`, `devCsp`, `withGlobalTauri: false`); the served child CSP string
  in `applications/installed_apps/scheme.rs` is byte-identical to its pre-#3146 value and still
  contains `connect-src ipc: http://ipc.localhost`.
  - EXPECT: quote the CSP string from `scheme.rs` and the `tauri.conf.json` keys; `git diff --stat` for
    `tauri.conf.json` empty. The shim adds ONE function to the host-authored bootstrap — it must not
    change the CSP, must not add `withGlobalTauri`, and must not introduce `__TAURI__`.
  - EDGE: a relaxed `connect-src` or a `withGlobalTauri: true` is a FAIL of this row AND of
    `webview-security-boundary` — the child's refusal must stay an ACL refusal, never a CSP refusal
    (F-2.2's EDGE depends on the transport staying reachable).

- [ ] **R-8.4 — no false refusals from the new manifest validator, and the absent key stays absent.**
  - EXPECT: all seven #3147 package fixtures from `build-package-fixtures.mjs` still produce the codes
    their committed expected-output manifest names — in particular the **valid** package still installs
    (a validator that now requires `capabilities`, or that rejects a package without it, is a total
    FAIL). The five #3147 behaviour fixtures from `build-behaviour-fixtures.mjs` still install. Quote
    each install's result.
  - EXPECT: a package with **no** `capabilities` key produces a normalized `<FREDO_DATA_DIR>/
    installed-apps/<id>/manifest.json` (and a `record.json`) where the key is **ABSENT** — not
    `"capabilities": null`, not `{}`. Quote the file. This is the on-disk half of the fail-safe NFR.
  - EDGE: `manifestVersion` is still `1`; the key is ADDITIVE and OPTIONAL. A bumped
    `manifestVersion`, or `capabilities` made mandatory, is a FAIL of the additive-only contract
    (a v1 package authored before #3146 must keep installing).

- [ ] **R-8.5 — the built-in application-data surface behaves exactly as before.** Cross-run
  `.opencode/tests/application-data/` (declared/canonical store rows) at the same tip.
  - EXPECT: that suite's declared-table rows (ensure/declare/read/write/delete/validate on a BUILT-IN
    application id) are green and **unmodified by this spec** (`git diff --stat origin/main...HEAD --
    .opencode/tests/application-data/` empty). Quote the run and the diff.
  - EDGE: editing that suite to accommodate the dispatcher is a **plan defect** — report it, never
    accept "suite updated". The dispatcher is a NEW surface in front of those bodies; it must not
    require them to change.

- [ ] **R-8.6 — consent never becomes a declaration.** Read the capability store's writes and the
  consent store.
  - EXPECT: `installed_app_consent_grant` cannot create a declaration (a grant for an undeclared
    capability is refused — F-7.21), the consent file lives at `<app_data_dir>/installed-apps-consent.
    json` **outside** the integrity-pinned `installed-apps/<id>/` tree (quote both paths and confirm
    the consent path is not inside an install directory), and it is versioned (`{"version":1,…}`) and
    written atomically (tmp + rename visible in the source, quoted).
  - EDGE: a consent record placed inside `<id>/` would be covered by the integrity manifest and could
    never be updated without a mismatch — a FAIL. A consent store with no version field is a FAIL of
    the additive-evolution contract.

## R-9 — The #3145 authoring kit must not become a second source of truth, and must not widen the install tier

> These rows are the "must not change" counterpart of `functional.md`'s **AC-8** group (#3145).
> The kit is a **projection** of three shipped things — the theme contract, the dispatch table and
> the manifest/capability validator. Each row below names the widening or the drift it would catch.
> **One exception to "must not change", stated up front: R-9.4.** `docs/ARCHITECTURE.md` MUST change
> (its installed-applications limitation table contradicts the shipped schema, `functional.md`
> F-8.16), so R-9.4 binds the diff's **shape** — confined and justified — never an empty diff.

- [ ] **R-9.1 — the theme is still ONE source, and the transport is untouched.**
  - EXPECT (the **exact** assertions — a subject is not a check): every `name → varName` pair **and**
    every derivation weight in `app/theme/contract/**` is **identical to `origin/main`**
    (`git diff origin/main...HEAD -- apps/ui/src/app/theme/contract/` shows **no** modified pair or
    weight — quote the diff; an added **named export** is the only permitted change); the contract's
    token **count grows by 0** (`SEMANTIC_TOKENS.length` before and after, quoted); `app/theme/
    system.ts`'s emitted Chakra config is unchanged; the kit's generator is a **consumer** of the
    contract — grep `packages/fredo-theme/` for a second hard-coded token list ⇒ **0**; and the
    transport files are byte-unchanged: `shared/installed-apps/themeCapture.ts` still reads the live
    DOM (no `SEMANTIC_TOKENS` import added), `installed_apps_push_theme` is still the one push
    command, `scheme.rs`'s `theme_style_block` still inlines `:root { … }`, `bootstrap.js`'s
    `__FREDO_APPLY_THEME__` is still the one apply path. Quote each and its `git diff --stat`.
  - EDGE: a kit that ships its own resolved **values** (not `var()` expressions) is a FAIL of NFR-5
    even if every parity row still passes — it would become a second colour source the moment the
    user changes an accent. A second token enumeration that drifts from the contract is the same
    FAIL. **A superset-only check is not enough on its own**: the published-var **coverage** inverse
    is `functional.md` F-8.24, and the two are bound together (a name the host never writes is the
    one lie a name-contract package can tell). Cross-run `theme-contract` and `theming`.

- [ ] **R-9.2 — the v1 manifest contract is additive-only, so a package authored before #3146 keeps
  installing.**
  - EXPECT: `SUPPORTED_MANIFEST_VERSION` and `CAPABILITY_MANIFEST_VERSION` are both still `1`
    (`mod.rs:97,108`); `MANIFEST_TOP_LEVEL_KEYS` is still the 8-key set with `capabilities` **8th**
    (`manifest.rs:91-100`); `capabilities` is still **optional** — all seven #3147 package fixtures
    (none of which declares capabilities) still produce the codes their committed manifest names,
    and in particular `qa3147-valid` still installs. A package with **no** `capabilities` key still
    normalizes to a `<id>/manifest.json` where the key is **ABSENT** (not `null`, not `{}`) — quote
    the file.
  - EDGE: a schema generation that makes `capabilities` **required**, or that bumps
    `manifestVersion`, is a FAIL of the additive contract (R-8.4 is the sibling assertion from the
    #3146 side). **The published schema must not be stricter than the parser**: a `check` that
    refuses a package the product installs is a FAIL of NFR-6's "one machine-readable schema".

- [ ] **R-9.3 — the kit adds no command, no capability and no window class.**
  - EXPECT: the installed-app command list in `lib.rs`'s `generate_handler!` is **unchanged** by this
    spec — quote the `installed_app`-prefixed name list before/after and show it equal (this spec
    adds **no** backend command; development mode's command belongs to #3241);
    `DISPATCH_TABLE` is still the eight ordered actions (`dispatch.rs:87-96`); the capability
    directory still has **exactly one** file matching an `installed-<probe>` label, with
    `windows: ["installed-*"]` and `permissions: ["allow-installed-app-invoke"]` — the same parsed
    matcher F-2.5/R-1.3 use (never a raw `installed-` grep, G-430).
  - EDGE: a per-package capability file, a second permission, or a new label prefix minted by this
    spec is a FAIL. Quote the per-file matcher result beside each file's `windows` array.

- [ ] **R-9.4 — the docs edit is CONFINED and every hunk is justified (not "empty").**
  - EXPECT: quote `git diff --stat origin/main...HEAD -- docs/` and `git diff -U3` for each touched
    doc file. Every hunk must sit inside one of the rows this spec's ST-5 dispositioned: the
    installed-applications limitation table (`ARCHITECTURE.md` ≈`:1110-1125`), the FAQ's
    installed-applications answer, the `SECURITY.md` installed-application containment section, the
    `README.md` product-documents table, and the new `docs/authoring-applications.md`. A hunk
    touching any **other** doc section is a FAIL — quote it.
  - EXPECT (both directions): the confined hunks are **also** insufficient if they are merely
    deletions — `docs/ARCHITECTURE.md`'s stale "no `capabilities[]`" claim must be **replaced with
    the truth** (F-8.16(ii)), not removed. An empty `docs/` diff is a FAIL too: it means the
    corrected doc did not land.
  - EDGE: a "tidy-up" of a historical record (`references.md` G-records, release notes, archived
    docs) is a FAIL even when the new prose is better — those are append-only. Cross-run the
    `navigation-prose-retirement` suite: this spec re-cuts its PR-5 in place (`functional.md`
    F-8.18), so that one row is **expected** to change and no other row in it may.

_Evidence convention: quote the artifact. A build/unit gate quotes `EXITCODE=`; a static case quotes
the file:line and the assertion; a live case quotes the observed value._

---

## R-10 — the #3144 management surface must not widen the frozen boundary, hollow the pane, or move the launcher

- [ ] **R-10.1 — the frozen vocabularies do not grow.**
  Read `apps/tauri/src-tauri/src/applications/installed_apps/mod.rs` (`InstalledAppRefusalCode` + its
  `ALL`/`as_str` unit pin) and the authority vocabulary (`authority.rs`).
  - **EXPECT:** `InstalledAppRefusalCode` is still **exactly 22** — quote the committed pin's assertion
    **and** its count; the authority vocabulary is still the separate **six**; the two types stay
    distinct (no authority code smuggled into `InstalledAppRefusalCode`; the frontend mirrors stay
    distinct: `INSTALL_REFUSAL_COPY` vs `CAPABILITY_REFUSAL_COPY`). #3144 reuses `id_not_installed` and
    `io_error` and adds **nothing**.
  - **EDGE:** a 23rd installer code added to carry the disabled/removal outcome is a **plan defect**
    (R-8.2) — report it; never accept it. This row is the #3144-shaped restatement of R-8.2's property
    (R-8.2 itself is NOT re-cut).

- [ ] **R-10.2 — the open path's behaviour for an ENABLED application is unchanged.**
  Read `apps/tauri/src-tauri/src/applications/installed_apps/commands_window.rs` (`installed_app_open`)
  and `window.rs` (`resolve_open_target`).
  - **EXPECT:** the disabled check (`lifecycle::is_disabled`) is inserted **before** `resolve_open_target`
    and changes nothing else: an enabled app still runs `resolve_open_target` → `scheme::verify_install`
    → `open_installed_app_window` as before; the singleton window behaviour, the `fredoapp` origin, the
    declared-table materialisation and the close path (`close_installed_window`) are untouched. Quote the
    inserted clause and the unchanged lines around it.
  - **EXPECT (live):** with A1 enabled, `installed_app_open` resolves and the `installed-<id>` window
    renders `installed-app-root` exactly as `F-1.3`/`S-5` already assert.
  - **EDGE:** a gate placed AFTER materialisation (so a disabled app still writes/registers tables) is a
    FAIL of the "no side effect from a disabled open" clause.

- [ ] **R-10.3 — a disabled application keeps its registry directory, so re-install is still refused.**
  Read `apps/tauri/src-tauri/src/applications/installed_apps/store.rs` (the `already_installed` check)
  and drive an install of an already-installed (and now disabled) id.
  - **EXPECT:** `installed_app_install` of a disabled app's id is still refused `already_installed` (the
    `<id>/` directory remains in the registry; disabling does not remove it). Quote the code.
  - **EDGE:** a disable that renames or hides the directory so the install check no longer fires would
    let a second copy land — FAIL.

- [ ] **R-10.4 — the pane's retained structure is intact.**
  `Read` `apps/ui/src/applications/settings-app/components/InstalledAppsSettings.tsx`; grep the
  `__tests__` for the retained assertions.
  - **EXPECT:** the pane keeps `role="list"`/`listitem`, and ALL of: the loading state, the empty state
    (`installed-apps-empty`), the populated state, the refusal state, the success state, and the
    `list-load-failed` state; the **absent-key render rule** (an absent optional key renders nothing);
    the **v1 limitations block** (`installed-apps-limitations`); the **install action row** with the
    unsigned-package note; and the **"no Open control here"** rule (quote it — the pane is a registry
    view). No new token, no new colour, no animation.
  - **EXPECT (the grants heading/intro carry the ADJUDICATED values, not the superseded high-risk-only
    datum — Adjudication 10.3):** the section heading reads `CONSENT_SECTION_HEADING` = **"What each
    application can reach"** and the intro reads `CONSENT_SECTION_INTRO` = **"Every application declares
    what it needs. It can only reach what it declared for itself. Anything that can change data or run
    programs is refused until you allow it, for that application only."** The constant **names** and the
    element id `installed-apps-consent-heading` are RETAINED; `CONSENT_SCOPE_LINE` is **kept verbatim**
    ("Allowing or revoking here never removes an application or its data."). Quote the heading/intro
    text actually rendered. A surviving `'Extra permissions'` heading, or the old high-risk-only intro,
    is a FAIL — and so is a heading read from the wrong element (assert against
    `aria-labelledby="installed-apps-consent-heading"`'s target).
  - **EXPECT (`data-consent-state` values are the ADJUDICATED three — Adjudication 10.2):** every
    `installed-apps-consent-row` carries `data-consent-state` ∈ {`allowed`,`not-allowed`,`none`}; an app
    declaring **no** high-risk capability reads **`none`** (never `allowed`). Quote each row's value.
  - **FAILABILITY:** the pane's existing component/unit tests redden on any of the above changing.

- [ ] **R-10.5 — the launcher's untouched parts.**
  Read `apps/ui/src/applications/home/components/launcher/LauncherInstalledAppsSection.tsx`.
  - **EXPECT:** the section is still a **sibling of the app grid** with no verb, no place and no stroke;
    it still renders **nothing** when its filtered list is empty; the absence rule and the "own window"
    line are unchanged. The ONLY change is `filterInstalledApps` dropping `state === 'disabled'`;
    a **`failing`** app is still listed and openable.
  - **FAILABILITY:** the launcher's own unit test (`LauncherInstalledAppsSection.test.tsx`) reddens if
    the section gains a control or a keyboard-navigation surface.

- [ ] **R-10.6 — the capability / manifest / config boundary is untouched.**
  `Read` `apps/tauri/src-tauri/capabilities/installed-app-commands.json`, `permissions/app/default.toml`,
  `src/runtime/command_manifest.rs`, `src/runtime/capability_guard.rs` and `tauri.conf.json`.
  - **EXPECT:** `installed-app-commands.json` is exactly `allow-installed-app-invoke` (no `core:*`, no
    new grant); `command_manifest.rs`'s three guards are green (registered ⊆ manifest; every registered
    command granted; the installed tier's one capability); `tauri.conf.json`'s `app.security.csp`,
    `devCsp`, `withGlobalTauri:false` are unmodified. Quote the JSON and run
    `cargo test --lib --locked command_manifest` (quote the test names).
  - **EDGE:** a per-application capability or a command added outside the three named ones is a FAIL.

- [ ] **R-10.7 — build hygiene.**
  Run and quote exit codes with `run-exitcode.ps1`:
  - `pnpm --filter @fredo/ui build` ⇒ `EXITCODE=0` (no TypeScript errors);
  - `cargo check --locked` (from `apps/tauri/src-tauri`) ⇒ `EXITCODE=0` with **zero** `warning:` lines.
  - **EDGE:** a suppressed warning (`#[allow(...)]`) to reach zero is a FAIL of the engineering rules.

- [ ] **R-10.8 — the lifecycle state is NOT read at startup.**
  `Read` `apps/tauri/src-tauri/src/lib.rs`'s setup closure; grep it for
  `lifecycle|installed-apps-state|read_state|is_disabled`.
  - **EXPECT:** **zero** hits — nothing is added to the setup closure; the state file is read only per
    listing (`installed_apps_list`) and per `installed_app_open` (R-5.5 of #3147 holds). Quote the
    grep's zero line count together with the resolved path it scanned (a zero over the wrong file is
    not a pass).
  - **CONTROL:** the same grep over `commands_install.rs` / `commands_window.rs` MUST return hits — the
    absence above is real, not an instrument aimed at the wrong file (G-408/G-469).

- [ ] **R-10.9 — the superseded pin is re-cut, in BOTH directions (G-374).**
  - **EXPECT A (the old assertion is gone):** grep `functional.md` and
    `apps/ui/src/applications/settings-app/components/__tests__/InstalledAppsSettings.test.tsx` for
    `querySelectorAll('button').length === 0` — **zero** surviving occurrences (the three re-cuts in
    `RECUTS.md` applied). Quote the zero line count **and** the scanned paths.
  - **EXPECT B (the replacement is TRUE against the shipped component):** the entry row renders
    **exactly** its state's management controls (`installed-apps-disable`/`-enable` + `-remove`) and no
    other button; the consent `grant`/`revoke` controls are **outside** every entry row (assert their
    nearest `[data-testid="installed-apps-entry"]` ancestor is `null`). Quote the component's rendered
    control set.
  - **FAILABILITY:** a row weakened to "≥1 button" reddens EXPECT B's exactly-set clause; a surviving
    `length === 0` reddens EXPECT A.
  - **EDGE:** a test that deletes the pin outright (rather than re-cutting it) also fails this row —
    the guarantee (no grant/revoke control inside a row) must remain asserted.

- [ ] **R-10.10 — the install-time refusal copy never renders in the INVENTORY context (an ABSENCE
  assertion — it fails loudly on reinstatement).**
  Read the inventory surfaces — `InstalledAppsSettings.tsx`, the NEW
  `apps/ui/src/shared/installed-apps/failureReasons.ts` (Adjudication 10.4, add to ST-3's owner files),
  and `apps/ui/src/shared/installed-apps/refusals.ts` — and drive the failing inventory row live.
  - **EXPECT (absence, with the exact install-time text quoted):** neither of these two
    `INSTALL_REFUSAL_COPY` sentences is **rendered** in the inventory context:
    - `INSTALL_REFUSAL_COPY[io_error]` = **"Fredo couldn't finish that install."**
    - `INSTALL_REFUSAL_COPY[id_not_installed]` = **"That application isn't installed any more."**
    Neither may appear in `installed-apps-entry-failure` (for a damaged-but-installed app), in
    `installed-apps-action-refusal`, or anywhere else in the pane / the launcher.
  - **EXPECT (the positive control — a vacuous absence is not a pass, G-408/G-469):** the SAME round
    shows `installed-apps-entry-failure` rendering a **non-empty** sentence from
    `installedAppFailureReason(entry.failureCode)` for a `failing` row — so the absence of the two
    install-time sentences is a real reading, not a blank pane. Quote both the absent-string check
    (zero hits, with the scanned paths) and the present sentence.
  - **WHY (the honest-module property):** the two contexts assert **different claims** — an install/open
    refusal claims *"the package was refused"*; an inventory failure claims *"the installed
    application's record is unreadable"* — so this is **one source per claim**, not a second source of
    truth for one claim. The mapping is `code → copy` **per context**, so neither can silently borrow
    the other's text. A future "unification" of the two modules that reintroduces the install-time
    sentence for an installed application **fails at this row**, at that moment.
  - **FAILABILITY:** a unification that points the inventory row back at `INSTALL_REFUSAL_COPY`
    reddens this row (the two sentences render again).
  - **EDGE:** a `failing` row whose reason is the *install* sentence is exactly the defect; a row whose
    reason is a paraphrase is a **copy** finding to route to UI/UX, not a PASS by substitution.
