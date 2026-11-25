# settings-credits — Regression

> "Must not change" baseline for **Settings → Credits** (Spec #3206). A green functional run does
> not clear these: the Credits surface is additive to a security boundary, a build gate and a
> settings shell, and each of those can break while every Credits row stays green.
>
> **Overlapping prior suites (run them too, do not duplicate their rows):**
> `.opencode/tests/webview-security-boundary/` (external-link baseline + capability surface),
> `.opencode/tests/companion-embedded-engine/` (its notices row reads §1/§2 of the doc),
> `.opencode/tests/installable-apps/` (installed-app window isolation),
> `.opencode/tests/settings/` (the Settings shell chrome).

## R-1 — The pre-existing Settings sections are untouched

- [ ] **R-1.** Run the pre-existing shell/section suites:
      `pnpm --filter @fredo/ui test:run src/applications/settings-app` via `run-exitcode.ps1`.
  - **Expected:** `EXITCODE=0`; the named suites all run and pass —
    `SettingsSurface.installedApps`, `SettingsSurface.ingest`, `SettingsSurface.theming`,
    `SettingsSurface.zeroSections`, `SettingsSurface.companionGate`, `LayoutSettings`,
    `AppPresentationSettings`, `InstalledAppsSettings`, `SettingsFeature.contract`.
  - **Fails if:** a suite is renamed/deleted, an assertion is weakened, or
    `settings-nav-installed-apps` loses its "immediately before the Applications group" position
    (the installed-apps suite asserts that pair with `compareDocumentPosition`).
  - **Edge:** `SettingsSurface.zeroSections` stubs only four sections and does not mock the
    credits module — if importing the Credits component breaks that render (a module-scope
    side effect), it fails there. That is a real signal, not a flaky test.
- [ ] **R-2 (live).** Click each pre-existing static nav item (Companion, Appearance,
      Fredo Setup, Telemetry, Apps, Background capture, Database, Layout, Installed
      applications) once.
  - **Expected:** each renders its own pane; no pane is blank; `credits-settings` is absent
    unless Credits is active (the section switch is exclusive).
  - **Shell-chrome baseline (re-derived — the old `SaveFooter` clause was stale and could never
    pass):** the shell renders **no** save footer on ANY section today. `SaveFooter`
    (`SettingsSurface.tsx:85-117`) returns `null` whenever
    `useSettingsSaveContext().saveFn` is null; its registration hook `useSettingsSave`
    (`applications/settings/SettingsSaveContext.tsx:51`) has **zero call sites** under
    `apps/ui/src`, and the footer carries no `data-testid` at all — so a `*save*` / `*footer*`
    testid query reads 0 by construction, on every section, Credits included.
  - **What to assert instead (still able to fail):** on the same live visit, read on three
    sibling sections (`companion`, `apps`, `installed-apps`) **and** on `credits`:
    (a) the count of `[data-testid*="save"], [data-testid*="footer"]` nodes, and (b) the count of
    `button`s whose whitespace-normalised text is exactly `Save`. Before the zero is trusted, run
    the same two queries over a control node — append
    `<div data-testid="__probe-save-footer"><button>Save</button></div>` to the content region,
    require both counts to rise by exactly 1, remove it, re-count (G-430: a zero from a selector
    that cannot see such a node is a blind spot, not a reading).
  - **Expected:** both counts are EQUAL across the four sections and none changes when Credits is
    opened and closed — the chrome is shell-owned, not pane-owned. **Fails if:** Credits (or a
    neighbour) starts rendering a save footer, the `if (!saveFn) return null;` gate is removed, or
    one section's count differs from the others. Do not restore the old wording — it asserted a
    footer that this tree never renders.

## R-3 — The webview capability surface is unchanged (the opener must not widen it)

- [ ] **R-3.** `powershell -NoProfile -File .opencode/scripts/inspect-webview-config.ps1`.
  - **Expected:** every `CHECK <name> PASS` line, in particular
    `capabilities.expected-files` (exactly `default.json`, `mcp-bridge-dev.json`,
    `app-commands.json` — **no new capability file**), `capabilities.all.no-shell-exec`,
    `app.withGlobalTauri=false`, and the CSP set (`script-src` without `'unsafe-inline'`,
    `style-src 'unsafe-inline'`, `connect-src` with `ipc:`).
  - **Fails if:** a capability file is added or edited, `shell:allow-open` reappears, the CSP is
    relaxed (e.g. `connect-src https:`), or `withGlobalTauri` flips to true.
  - **Edge:** the new command is granted through `permissions/app/default.toml` +
    `capabilities/app-commands.json` (`["main","terminal","doom","app-*"]`). Adding an
    `installed-*` label there removes installed-app isolation (see R-5).
- [ ] **R-4.** Read `apps/tauri/src-tauri/src/lib.rs`'s `generate_handler![…]` and
      `apps/ui/src/applications/settings-app/credits/CreditsSettings.tsx`.
  - **Expected:** the only new webview→OS path is `open_external_link`; no product source calls
    `tauri_plugin_shell`'s open/spawn/execute, `window.open` is not used by the Credits module,
    and the Credits module imports no `@tauri-apps/api` statically (the bridge's dynamic import
    is the only route).
  - **Fails if:** a `Link href`-style navigation, `window.open`, or a shell call is introduced to
    make the link "work".

## R-5 — Installed applications still match no capability

- [ ] **R-5.** Grep every `apps/tauri/src-tauri/capabilities/*.json` for `installed-`.
  - **Expected:** **0** matches; and `permissions/app/default.toml` is still a permission *set*
    (no `windows` key).
  - **Why it can regress here:** this spec adds a *command* that launches an OS handler. The one
    way to hand that to an installed app is a capability label — the isolation of every
    installed application would silently disappear while every Credits row stayed green.

## R-6 — Build hygiene and CI parity

- [ ] **R-6.** `run-exitcode.ps1` each: `pnpm --filter @fredo/ui typecheck`,
      `pnpm --filter @fredo/ui build`, `pnpm --filter @fredo/ui test:run`,
      `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`.
  - **Expected:** every `EXITCODE=0`; zero TypeScript errors; zero Rust warnings; no
    `#[allow(...)]` added anywhere in the diff; the generated artifact is under ~150 KB
    (MIT 21 lines + Apache-2.0 202 lines + BSD text + prose — a runaway artifact means the
    generator is embedding something it should not).
  - **Expected (`Cargo.lock`):** the diff adds NO `[[package]]` block (no new crate is
    distributed) — but it MUST show `"open"` inside the `fredo` package's `dependencies` list
    (`Cargo.lock:1905`), because a transitive crate promoted to a direct dependency is recorded
    as a dependency edge even at the same resolved version. A `--locked` failure reading "the
    lock file needs to be updated" is a developer defect whose fix is committing the lock
    update — never dropping `--locked` here.
  - **Edge:** `pnpm --filter @fredo/ui build` runs `tsc` over `src`, which type-checks the
    generated module — a generator emitting text that cannot be parsed as TS fails here, not
    only in vitest.

## R-7 — The doc change is additive (no existing notice row is rewritten)

- [ ] **R-7.** Read `docs/THIRD_PARTY_NOTICES.md` and confirm the pre-existing rows are
      byte-identical (ST-1 adds only): §1 whole table including
      `| Pinned upstream revision | 785322d17f (b12032+1), from https://github.com/ggml-org/llama.cpp |`;
      §3 including `| Version | 0.6.7 …` and the full BSD 3-Clause body; §4's
      `| Size | 4,196,020 bytes |` and its `Redistribution note` / `References`; §5 and §6
      unchanged in substance (no new component promoted out of them).
  - **Expected:** only these changes exist: §2 gains a `Distribution form` column; §4 gains
    `License` / `Upstream` / `Distribution form` rows; §7.1 gains a `Distribution form` row.
  - **Fails if:** a §5/§6 entry is folded into the include set (R-4.3), an existing licence
    identifier is reworded, or the BSD body is truncated/moved out of the doc (its text is the
    artifact's body for `neurodoom`, so a truncation silently truncates the in-app licence —
    F-4-style equality only covers MIT/Apache, so this row is the guard for §3's body).
  - **Edge:** the file's footer (`*Authored by Developer - Spec #3023 (ST-8); amended by Spec
    #3141 (ST-6); …*`) gains this spec's amendment — an untracked amendment is a doc-hygiene
    FAIL, not a content FAIL.
- [ ] **R-8.** `run-exitcode.ps1 -Command "powershell -NoProfile -File .opencode/scripts/check-navigation-prose-retired.ps1"`.
  - **Expected:** `EXITCODE=0` and the printed `Scanned files:` count includes
    `docs/THIRD_PARTY_NOTICES.md` (it is inside a scanned root; the script lists the doc as an
    allowlisted prefix). The commit that adds this suite must also be scanned clean — the new
    `.opencode/tests/settings-credits/*.md` files are inside a scanned root.
  - **Edge:** a hit in one of the NEW suite files is a suite defect to fix here, not a product
    finding.

## R-9 — The other external-link baseline is still the baseline

- [ ] **R-9.** Re-run `.opencode/tests/webview-security-boundary/functional.md` **F-7** (live):
      `window.open('https://example.com','_blank')` from the webview.
  - **Expected:** returns `null`; no new Tauri window; no browser opens from it. **Unchanged by
    this spec** — the opener command is a separate, explicit path; no `on_new_window` handler and
    no opener plugin were added.
  - **Fails if:** the new work "fixes" `window.open` (that would be a behaviour change no AC
    asked for and would re-open the pre-existing inert-anchor surface).
  - **Edge:** five pre-existing `window.open(url,'_blank')` sites stay untouched — a migration
    of any of them is out of this spec's scope.
- [ ] **R-10.** Re-run `.opencode/tests/companion-embedded-engine/functional.md` **F-21** (the
      notices row: `llama.cpp` + `llama-cpp-4` dual `MIT OR Apache-2.0`, Vulkan's terms named).
  - **Expected:** still PASS on the spec tip — ST-1 is additive and removes nothing.
  - **Fails if:** the §2 column addition drops the `License / terms` column (which is what F-21
    reads) or renames a component.

## R-11 — No second content authority

- [ ] **R-11.** Grep `apps/ui/src/applications/settings-app/credits/` for a second copy of any
      notice string: any of the six component names, the five licence identifiers, or an
      `https://` URL literal outside `credits.generated.ts` / its `__tests__`.
  - **Expected:** every one of those literals lives in the generated artifact only (the tests may
    re-assert them); `CreditsSettings.tsx` and `externalLink.ts` carry no notice content and no
    URL.
  - **Why:** a hand-copied string is exactly what AC-4 forbids — it survives a doc edit and makes
    the gate's equality true while the shipped pane is stale.

_Evidence convention: quote the exit code, the file:line or the count; "unchanged" without a
quoted artifact is not evidence._
