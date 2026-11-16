# installable-apps — Functional Test Cases

> Durable functional suite for **feature domain `installable-apps`** (Spec #3147 — *install a
> package someone else built and open it inside Fredo*).
>
> **Verification policy: LIVE** for the behavioural rows, with **three STATIC sub-proofs** that must
> be read from source/config and never driven by a launch probe:
>
> - **(a)** R-2.4 grant absence — enumerate every `apps/tauri/src-tauri/capabilities/*.json` and match
>   the sample label against each file's declared reach;
> - **(b)** the window-label non-match against every capability `windows` glob;
> - **(c)** the grant chain — `COMMAND_MANIFEST` ↔ `generate_handler!` ↔ `permissions/app/default.toml`
>   ↔ the `capabilities/app-commands.json` grant to the built-in window class.
>
> A fourth row, **F-5.5**, is a **dual gate**: one `[static]` leg (the `lib.rs` setup-block read) plus
> one host-side `[live]` absence leg — both mandatory, neither may answer for the other.
>
> **No row in this suite uses `tauri_ipc_monitor`, and no row may be answered by one.** The monitor
> cannot witness APPLICATION invokes in this build (G-3098 — `references.md:43`): the adapter issues
> its invokes through an ES-module `invoke`, which bypasses both the monitor and a runtime wrapper on
> the internal handle. F-5.5's boot leg was the only candidate and it is carried instead by the static
> setup-block read plus two host-side absence instruments; the row pre-authorizes the named limitation
> `logic-verified — invoke not observable through the monitor in this build`.
>
> **The live receipts are live WEBVIEW receipts** — DOM/testid reads, `getComputedStyle` reads in the
> child document, `tauri_manage_window` listings, screenshots, and host log reads. This feature runs
> **no OTLP producer of its own**, so **E-SPAN is a NAMED BLOCKER**: if the env has no PostgreSQL
> port (manifest `ports.pg` = 0 / unreadable), record `E-SPAN: BLOCKED — no PostgreSQL port in this
> env` in the verdict and do **not** hunt for, fabricate, or substitute a `telemetry_spans` query.
> No row in this suite may rest on a span query alone.
>
> Every constant below is cited from the Architect's names block (Spec #3147 triage) — re-derive it
> there, never from this file, if it drifts. **Fixture ids are NOT pinned in this suite**: read the
> exact `id` / `version` / `engines.fredo` from the generator's committed expected-output manifest.

## Environment / driver

| Item | Value |
|---|---|
| Env | `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3147 -EnvId <id> -EnvSlot <n> -RequireIsolation` (never `Restart`, G-328) |
| Driver | `tauri_driver_session start` with the env's MCP port as `appIdentifier` (a decimal string) |
| Child window | `tauri_webview_*` / `tauri_webview_execute_js` with `windowId="installed-<id>"` |
| Host log | **Serve-line receipt (primary):** grep `<env-root>/logs/dev-env-stdout.log` for `fredoapp`, current boot only (documented direct read path — `dev-environment` SKILL.md:234). **Secondary, only if that source exists in this driver:** `tauri_read_logs(source="system", …)` — optional, never required (only `source="console"` is documented). Neither yields a line ⇒ **ARTIFACT defect to report to the Orchestrator**, never a PASS and never a row downgrade |
| Install root | the env lease's `FREDO_DATA_DIR` (default `<env-root>/data`) + `/installed-apps/` |
| First paint | a fresh isolated boot may take 3–5 min (G-386) — wait it out, do not call it a wedge |
| Pre-flight | `pnpm install --frozen-lockfile` if the spec added a UI dependency; check `resolveRef` (G-067) before any ref-based drive |

## Fixtures (both committed, deterministic, Node built-ins only)

| Generator | Owner | Emits |
|---|---|---|
| `.opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs` | ST-2 | valid package, no-manifest package, bad-manifest package, zip-slip package, hash-tamper package (+ committed expected-output manifest naming each id/code) |
| `.opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs` | ST-7 | probe app (invokes a real shipped command), lazy-trace app (`mount` stamps `data-mounted-at`), crash-on-load app, hang-on-load app, **fail-once-then-mount app** (throws on the first document load, mounts normally on the second — `sessionStorage` survives `location.reload()` within one window, so a per-document counter is the lever) |

Run each generator once before the round and record its output directory in the verdict. **Both
generators' full package/app lists are explicit sub-task deliverables** (G-409 — nothing this suite
requires is owned nowhere):

- `build-package-fixtures.mjs` (**ST-2**'s Work line) emits **all seven** packages: valid,
  no-manifest, bad-manifest, zip-slip, hash-tamper, **(i) an `engines.fredo`-incompatible package**
  (drives `host_incompatible`, F-3.3) and **(ii) a package containing a reserved `__fredo/` path**
  (drives `reserved_path`, F-3.5), plus the committed expected-output manifest naming each id/code.
  ST-2 also names a `zip`-crate availability fallback (central-directory parse over `flate2`) — which
  path was taken is recorded, and it does not change any row here.
- `build-behaviour-fixtures.mjs` (**ST-7**'s Work line) emits **all five** apps — probe,
  lazy-trace, crash-on-load, hang-on-load and the **fail-once-then-mount app** (F-4.3: throws on its
  first document load, mounts normally on the reload) — and must expose the probe app's caught
  rejection on the DOM (`[data-probe-result]` + `[data-probe-error]` in the child document) so the
  tester reads the refusal from the DOM, not the console.

---

> **Serve-line receipt (the ONE host-side serve instrument — used by F-3.*, F-4.3, F-5.1, F-5.4,
> F-5.5).** The scheme handler emits **one `tracing` line per served request containing the `fredoapp`
> URL** — that emission is **ST-3's** deliverable (it owns `scheme.rs`). Read it as: **(1) PRIMARY** —
> grep the env's own log file `<env-root>/logs/dev-env-stdout.log` for `fredoapp`, keeping only lines
> from the CURRENT boot (this is a grep of a log file, not a product-surface read); **(2) SECONDARY**
> — `tauri_read_logs(source="system", …)` **only if that source exists in this driver** (only
> `source="console"` is documented, `dev-environment` SKILL.md:407), never required. Semantics are
> identical under either instrument: a host-side serve line is a POSITIVE instrument that can only
> exist after a first open, so "zero lines before any open" + "≥1 after it" is a real discriminator.
> **If neither instrument yields a line that is an ARTIFACT defect, not a PASS and not a downgrade.**

---

## AC-1 — install and open (R-1.1 … R-1.5)

- [ ] **F-1.1 (R-1.1) [live]** — Settings → **Installed apps** (`[data-testid="settings-nav-installed-apps"]` → `[data-testid="installed-apps-pane"]`) → click `[data-testid="installed-apps-install-button"]` (accessible name **"Install application package..."**) → pick the **valid package**.
  - **EXPECTED:** `[data-testid="installed-apps-install-success"]` renders; `[data-testid="installed-apps-entry"][data-app-id="<fixture id>"]` present carrying the fixture's `displayName` and `version`; `installed_apps_list` (host `execute_js`) returns exactly one entry with `id`/`version`/`enginesFredo` equal to the fixture manifest; `<FREDO_DATA_DIR>/installed-apps/<id>/` contains `manifest.json`, `record.json`, `files/`.
  - **DATA:** valid package + its expected-output manifest entry.
  - **EDGE:** a SECOND install of a second valid id gives two entries; `description` unset in the manifest ⇒ the list entry has **no `description` key at all** (never `null`, never `undefined` reaching the DOM).

- [ ] **F-1.2 (R-1.1) [live]** — read the list projection's fields (G-417/G-418) from the rendered entry + the `installed_apps_list` JSON.
  - **EXPECTED:** the projection carries **identity** (`id`, `displayName`), **compatibility** (`enginesFredo`, the declared range verbatim — never a boolean), `version`, `installedAt` (RFC 3339), `windowLabel` = `installed-<id>`. **Needs is structurally empty in manifestVersion 1** — record the INERT resolution (`capabilities[]` does not exist in v1; #3146 makes it live) in the verdict instead of demanding a `needs` field.
  - **EDGE:** a projection that only carries identity is a FAIL of the compatibility axis; do not FAIL the row for the absent `needs` field (inert by PO/Architect decision, not a defect).

- [ ] **F-1.3 (R-1.2) [live]** — open the installed app from the launcher section (`[data-testid="launcher-installed-apps-section"]` → `[data-testid="launcher-installed-app"][data-app-id="<id>"]`), then repeat via `installed_app_open{appId}` from the host webview.
  - **EXPECTED:** a **new native window** appears (`tauri_manage_window action="list"` shows label `installed-<id>`); inside it `[data-testid="installed-app-root"]` is present and the fixture's own interface is visible (its authored DOM + screenshot); the window is NOT a host app window (`?view=app` route is absent) and carries no `app-*` label; the window's **OS title** is the app's `displayName`, not `installed-<id>` (UI/UX §3.4).
  - **EDGE:** opening an already-open app focuses the existing window instead of stacking a duplicate (`list` shows exactly one `installed-<id>`). **The settings pane deliberately has NO open control** (one open surface, one failure surface, UI/UX §3.1/§3.2) — a row asserting an Open button in the settings list is a FAIL of the design, not a product defect.

- [ ] **F-1.4 (R-1.3) [live] — LIGHT.** Set Settings → Appearance → `select[aria-label="Theme presets"]` to **`Light Default`** (`light-default`), open the app, then in the child read `getComputedStyle(document.documentElement).getPropertyValue('--body-bg')` / `--card-bg` / `--text-primary` / `--accent-primary` and compare with the same reads in the host.
  - **EXPECTED:** AC-1 verbatim — *"rendered with the user's currently active theme including light/dark and the user's accent"*. Per-token string equality host ↔ child for every token name the child declares; every value **non-empty**; the `colorScheme` reported in `window.__FREDO_INSTALLED__.theme` is `'light'`.
  - **EDGE:** a token the child declares but the host omits is a FAIL; an empty string on both sides is a VACUOUS PASS and must be re-driven.

- [ ] **F-1.5 (R-1.3) [live] — DARK.** Same as F-1.4 with preset **`Dark`** (`dark`).
  - **EXPECTED:** identical read set, all non-empty, equal host ↔ child, `colorScheme === 'dark'`, and the `--body-bg` string **differs from the F-1.4 light value** (positive discriminator: the appearance really travelled).
  - **EDGE:** a child that reports `'dark'` while its `--body-bg` is the light value is a FAIL of the derived-scheme rule.

- [ ] **F-1.6 (R-1.3) [live] — NON-DEFAULT ACCENT.** Restore a dark preset, then set `input[aria-label="Primary color"]` to a non-default accent (e.g. `#ff8800`), open the app, and compare `--accent-primary` and `--accent-secondary` host ↔ child.
  - **EXPECTED:** both strings equal host ↔ child, equal the override value, and **differ from the values observed in F-1.4/F-1.5** (so the accent is not a coincidentally-matching default). Screenshot the child as corroboration.
  - **EDGE:** an accent override applied while a Doom palette is active is a distinct state — record which palette governed and re-drive outside Doom mode.

- [ ] **F-1.7 (R-1.4) [live]** — with the app **closed**, change the preset (light → dark); then open it.
  - **EXPECTED:** the newly opened document carries the NEW values (equal to the host's post-change reads); the previous values are absent. This is the served-at-open moment — no IPC call is needed for correctness.
  - **EDGE:** open → close → change → re-open must reflect the change on the SECOND open, not only on the first.

- [ ] **F-1.8 (R-1.5) [live]** — with the app **open**, install a listener in the child that records `fredo-theme-change` (`document.addEventListener('fredo-theme-change', e => window.__qaThemeEvent = e.detail)`), then change the accent in the host and poll `window.__qaThemeEvent` / the `--accent-primary` read with a bounded wait (≤ 10 s).
  - **EXPECTED:** the child's `--accent-primary` becomes the new value **and** `[data-mounted-at]` on `installed-app-root` is **UNCHANGED** from before the change (proves *without reloading it*); the `fredo-theme-change` event fired.
  - **EDGE:** a change visible only after a reload is a FAIL of "without reloading"; a change that fires the event but leaves the token stale is a FAIL of the token apply.

## AC-2 — isolation is real, built-ins unaffected (R-2.1 … R-2.4)

- [ ] **F-2.1 (R-2.1) [live]** — from **inside** the child, `execute_js`: `window.location.origin`; read the host's `window.location.origin` from `main`.
  - **EXPECTED:** the two strings are **not equal** and the child's origin matches the platform form — this build is Windows, so `http://fredoapp.localhost` (macOS/Linux would be `fredoapp://localhost`). The host origin in a dev round is the Vite origin (`http://localhost:5174`) — whether you read the dev or the packaged origin, the assertion is **string inequality**, never a hardcoded host value.
  - **EDGE:** a child reporting an `about:blank` / empty origin is a FAIL (an opaque origin would also refuse, but it would not be the served document) — corroborate with `document.baseURI` and `[data-testid="installed-app-root"]`.

- [ ] **F-2.2 (R-2.2) [live]** — drive the **probe app** (ST-7) so its `mount` invokes TWO real shipped commands through `window.__TAURI_INTERNALS__.invoke(...)` and records the caught outcome on `[data-probe-result]` / `[data-probe-error]`:
  - (1) `save_control_setting` with key `qa3147-probe-child-<uuid>` (a **pre-existing** command with an observable side effect);
  - (2) `installed_apps_list` (a shipped installed-app command).
  - **EXPECTED:** AC-2 verbatim — *"its attempt to use Fredo's direct backend interface from inside the application is refused"*. BOTH invocations **reject**; the rejection is an **ACL / not-allowed authority error** (name the capability or the permission, not a network/`CSP`/`net::ERR` error); **and the handler did not run** — from the HOST, `get_control_setting{key: "qa3147-probe-child-<uuid>"}` returns `null`/`None` (no side effect exists), and no new entry appears in the install listing.
  - **NON-VACUITY CONTROL (mandatory, must be in the same round):** from `main`, invoke `save_control_setting{key:"qa3147-probe-host-<uuid>", value:"ok"}` then `get_control_setting` on that key ⇒ the value IS returned. This proves the command, the side effect and the read are all live, so the child's `null` means refusal, not a broken probe.
  - **DATA:** probe app + `get_control_setting` / `save_control_setting` on `main` (both registered, `lib.rs` generate_handler block).
  - **EDGE:** a network-level/CSP rejection instead of an ACL rejection is a FAIL of the sharper proof (the child document's `connect-src` deliberately keeps `ipc: http://ipc.localhost` reachable); a probe that reports success is a total FAIL of AC-2.

- [ ] **F-2.3 (R-2.3) [live]** — open a built-in app that uses the shipped surface today (e.g. Database Client or Terminal from the launcher) and, from `main`, invoke a command the built-in UI uses today (`get_control_setting{key:"app_window_presentation"}`).
  - **EXPECTED:** AC-2 verbatim — *"the applications Fredo ships with continue to behave exactly as they do today"*: the built-in window opens and renders its content; the `main` invoke **succeeds** (not refused); the `app-*` window it creates is unaffected.
  - **EDGE:** a capability-denied error on ANY built-in window is a FAIL of this row and of `webview-security-boundary` R-1/R-3.

- [ ] **F-2.4 (R-2.3) [static+unit]** — the boot registry is unchanged: run `pnpm --filter @fredo/ui test:run src/applications/__tests__/retainedApplicationSet.test.ts`.
  - **EXPECTED:** all three cases green and the file **unmodified** by this spec (`it('registers exactly the eight retained features (no more, no fewer)')`; the pinned map is `wireframe, terminal, mission-monitor, database-client, theming, setup, settings, dev-mode`). Installed apps must not appear in `getApplications()` — grep `apps/ui/src/shared/installed-apps/` for `registerApplication(` = 0.
  - **EDGE:** editing that test (or registering an installed app through the registry) is a plan defect — report it, do not accept a "test updated" PASS.

- [ ] **F-2.5 (R-2.4) [static]** — **grant absence.** Enumerate **every** file under
  `apps/tauri/src-tauri/capabilities/` with a **directory listing** (never a Glob; the directory is
  enumerated at test time and its COUNT is not the assertion — list what you actually find) and, for
  each file, glob-match the sample label `installed-<fixture id>` against every entry in its `windows`
  array. Put every filename AND every file's full `windows` array in the evidence.
  - **EXPECTED (the binding, hard-FAIL assertion):** **zero** capability files' `windows` list
    matches `installed-<id>` — no `*`, no `installed-*`, no bare `installed-` prefix, no wildcard that
    would match it, and none reaching it through a `webviews` entry either. Quote the per-file matcher
    result next to that file's `windows` array. Each file MUST declare its reach explicitly: an absent
    or empty `windows` (and no `webviews`) is a **FAIL of this row**, never a silent "matches nothing"
    — quote the whole file in that case.
  - **EXPECTED (no widening):** every `windows` array is exactly
    `["main","terminal","doom","app-*"]` or a strict subset of those four labels — **no capability
    targets a window pattern outside that pre-existing set**. **A capability whose purpose is to grant
    the app-manifest `default` permission set (`permissions/app/default.toml`, which restates the
    commands the built-ins already had) to exactly those four pre-existing built-in patterns is
    EXPECTED and NOT a violation** — that is `capabilities/app-commands.json`, and it is what keeps
    R-2.3 true now that `build.rs` registers the app manifest. A capability that ADDS a window
    pattern, or that grants a permission to `installed-*`, IS a FAIL.
  - **EXPECTED (source of the grant):** `apps/tauri/src-tauri/permissions/app/**` (the hand-authored
    set) is referenced only from `capabilities/app-commands.json`; it is a permission SET, never a
    capability (it carries no `windows` key).
  - **NON-VACUITY CONTROL:** apply the SAME matcher to `app-terminal` ⇒ it matches `app-*` (so the
    matcher is not silently matching nothing).
  - **EDGE:** a new capability file with a permissive `windows` entry (`"*"`, `"installed-*"`) is a
    FAIL even if it grants no permission; the generated `permissions/autogenerated/` tree is a BUILD
    artifact — state the `cargo check` precondition and read it only as corroboration (G-425).

- [ ] **F-2.6 (R-2.4) [static]** — **label non-match, from the code that builds the label.** Read `INSTALLED_APP_WINDOW_LABEL_PREFIX` (value `"installed-"`) and `installed_app_window_label` in `apps/tauri/src-tauri/src/applications/installed_apps/window.rs`, and the built-in prefix `GENERIC_APP_WINDOW_LABEL_PREFIX = "app-"` in `infrastructure/app_window.rs:54`.
  - **EXPECTED:** the installed prefix is `"installed-"`, the built-in prefix is `"app-"`, and **no global pattern in ANY** `apps/tauri/src-tauri/capabilities/*.json` `windows` (or `webviews`) entry can ever match a label starting `installed-` — check every file, not a remembered list of globs (F-2.5 owns the per-file enumeration and matcher results; this row owns the label-prefix fact). The built-in builder path (`app_window.rs` `open_app_window`) is untouched by this spec.
  - **EDGE:** an `installed-` label that could also be produced by `app_window_label()` is a FAIL (two owners for one label namespace).

- [ ] **F-2.7 (R-2.3) [static+unit]** — **command-list / grant chain guard.** Run `cargo test --lib --locked` (from `apps/tauri/src-tauri`; disclose if `nextest` is absent — G-282) and read `src/runtime/command_manifest.rs`.
  - **EXPECTED:** both `#[cfg(test)]` guards in `runtime::command_manifest::tests` are green; quote each title VERBATIM from the committed source (G-419) and quote the assertion as written:
    (1) `every_registered_command_is_in_the_manifest` — parses the `generate_handler!` block in `lib.rs` and asserts the **SUPERSET** direction, *every registered command appears in `COMMAND_MANIFEST`*; name a command whose absence it would catch.
    (2) `every_registered_command_is_granted_to_the_built_in_windows` — asserts every **registered** command has its `allow-<command>` grant in `permissions/app/default.toml` **and** that `capabilities/app-commands.json` references the `default` set and still targets all four built-in labels (`main`, `terminal`, `doom`, `app-*`).
  - **WHY both (the chain, stated because the gate is now ON):** with `build.rs` registering `AppManifest::commands(...)`, a command reaches a built-in window only through **manifest → permission set → capability grant**. Guard (1) covers the first link; guard (2) covers the other two — and `permissions/app/default.toml` alone grants nothing to any window until `capabilities/app-commands.json` references it, which is the link that keeps R-2.3 true.
  - **EDGE:** do **not** demand the reverse direction (manifest entry ⇒ registered) as a gate: entries legitimately land in the manifest ahead of their registration as the ST chain progresses, so a bidirectional assertion would FAIL mid-chain by construction. At the spec tip, list any unregistered manifest entry as a **hygiene note** (corroboration), never as a FAIL of this row. A registered command absent from the manifest IS the FAIL guard (1) exists for; a registered command ungranted, or a `app-commands.json` that has lost a built-in label, IS the FAIL guard (2) exists for.

## AC-3 — a bad package is refused, not half-installed (R-3.1 … R-3.5)

> Every refusal row asserts the SAME three-part invariant: **(i)** the message names the specific
> reason, **(ii)** nothing is installed, **(iii)** nothing is executed. The device for (i) is
> `[data-testid="installed-apps-refusal"]` (`role="alert"`, `data-refusal-code="<code>"`) plus
> `[data-testid="installed-apps-refusal-reason"]`. For (ii): `installed_apps_list` and
> `[data-testid="installed-apps-entry"]` are unchanged **and** a directory listing of
> `<FREDO_DATA_DIR>/installed-apps/` shows no new `<id>/`. For (iii): `tauri_manage_window
> action="list"` shows no new `installed-*` window **and** the host log gains no serve line for that id
> (per the **Serve-line receipt** above — grep `<env-root>/logs/dev-env-stdout.log`; the
> `source="system"` read only if that source exists in this driver).

- [ ] **F-3.1 (R-3.1) [live]** — choose the **no-manifest package**.
  - **EXPECTED:** `data-refusal-code="no_manifest"`; the rendered reason is the distinctive
    `INSTALL_REFUSAL_COPY.no_manifest` sentence, readable as text (never colour-only); (ii) + (iii) as above. AC-3 verbatim — *"installation is refused with a message naming the specific reason, nothing is installed, nothing is executed, and Fredo continues working normally"*.

- [ ] **F-3.2 (R-3.2) [live]** — choose the **bad-manifest package**; read the code it produces from the generator's committed expected-output manifest (do not assume which of `manifest_malformed` / `manifest_unknown_field` / `manifest_invalid_field` / `unsupported_manifest_version` it drives), then read the rendered reason.
  - **EXPECTED:** the rendered text equals `INSTALL_REFUSAL_COPY[<that code>]` verbatim; for a field-scoped code the reason names the field; (ii) + (iii) hold. This single leg satisfies the **manifest family** sweep — the remaining family codes are covered by the copy-map unit pin (F-6.2).
  - **EDGE:** unparseable JSON vs a valid object with an unknown key vs an unsupported `manifestVersion` are DIFFERENT codes — record which one the fixture actually is; a fixture that silently produces a different family's code is an artifact gap to report, not a PASS.

- [ ] **F-3.3 (R-3.3) [live]** — choose the **incompatible-`engines.fredo` package** (ST-2 generator extension, see Fixtures).
  - **EXPECTED:** `data-refusal-code="host_incompatible"`; the reason names the declared range and/or the running Fredo version; (ii) + (iii) hold. Also drive a **control**: an `engines.fredo` range that DOES include the running version installs successfully in the same round.
  - **EDGE:** `*`, an empty string, and an unparseable range are refused as `engines_range_invalid` (NOT `host_incompatible`) — record the code, don't collapse the two.

- [ ] **F-3.4 (R-3.4) [live]** — choose the **zip-slip package**.
  - **EXPECTED:** `data-refusal-code="unsafe_path"`; (ii) + (iii) hold; and no file exists outside `<FREDO_DATA_DIR>/installed-apps/` afterwards (spot-check the app-data dir root and the env root listing).
  - **EDGE:** an absolute-path entry, a drive/UNC prefix entry, and a symlink type entry are the same family — extend the generator only if the round needs them; otherwise record which entry shape was actually exercised.

- [ ] **F-3.5 (R-3.4) [live+unit]** — choose the **reserved `__fredo/` path package** (ST-2 generator extension), and read the archive budget constants.
  - **EXPECTED:** `data-refusal-code="reserved_path"`. Then confirm the caps are enforced, not just declared: the unit test in `archive.rs` accepts exactly at the cap and rejects at cap+1 for **4 096 entries**, **256 MiB total uncompressed** and **64 MiB per file** (all three ⇒ `archive_too_large`); quote the test names + the constants.
  - **EDGE:** a cap asserted only by a comment or a constant with no boundary test is a FAIL of "enforced"; a per-file 64 MiB file inside a 256 MiB archive must reject on the per-file rule first — record which fired.

- [ ] **F-3.6 (R-3.1/R-3.2 family) [live]** — install the **valid package twice**.
  - **EXPECTED:** the second attempt is refused `already_installed` with its own distinct sentence, and the FIRST installation is intact (still listed, still openable, its files untouched).
  - **EDGE:** a second install must not leave a half-written `<id>/` — the existing `<id>/record.json` is byte-identical before/after.

- [ ] **F-3.7 (R-3.5) [live]** — immediately after any refusal, without restarting anything: install a valid package, open it, and open a built-in app.
  - **EXPECTED:** both succeed; the refusal surface is data on screen (no crash); the host webview is interactive (`[role="searchbox"]` accepts typing) and the console shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`. AC-3 verbatim — *"Fredo continues working normally"*.
  - **EDGE:** a wedged install button (disabled forever) is a FAIL of this row even if the reason copy rendered.

## AC-4 — failure is contained (R-4.1 … R-4.5)

- [ ] **F-4.1 (R-4.1) [live]** — open the **crash-on-load app**.
  - **EXPECTED:** AC-4 verbatim — *"Fredo stays alive and responsive, the user sees a failure specific to that application"*: inside the child, `[data-testid="installed-app-failure"]` is present with heading **"Couldn't open <displayName>"** and a plain-language `[data-testid="installed-app-failure-reason"]`; the HOST is alive (window list answers, the launcher searchbox still accepts input, another app still opens) and no host error dialog appears. The failure names THIS app's `displayName`, not a generic message.
  - **EDGE:** a host-side crash/blank main window is a total FAIL; a failure panel naming a different app is a FAIL.

- [ ] **F-4.2 (R-4.2) [live]** — open the **hang-on-load app** and time from the `installed_app_open` resolve to the failure panel (quote the measured ms).
  - **EXPECTED:** `[data-testid="installed-app-failure"]` appears with reason `mount_timeout`, and the measured interval lies in **[9 000 ms, 20 000 ms]** — the watchdog is `INSTALLED_APP_MOUNT_TIMEOUT_MS = 10_000` measured from document commit, so an early panel (< 9 s) means the budget was not honoured and a much later one means the bound is not enforced. Quote the number.
  - **EDGE:** while the app hangs, the host must stay interactive — click the launcher searchbox and type during the wait (a frozen host is a FAIL even if the panel eventually appears).

- [ ] **F-4.3 (R-4.3) [live]** — open the **fail-once-then-mount app** (throws during the first document load, mounts normally on the second), wait for the failure panel, then click `[data-testid="installed-app-retry"]` (text button **"Try again"**). Repeat the whole cycle twice (open → fail → retry → loads).
  - **EXPECTED:** AC-4 verbatim — *"the application can be tried again without restarting Fredo"*, and the retry succeeds: after one click on **"Try again"** the failure panel is gone, `[data-testid="installed-app-root"]` shows the app's own interface, and a `data-mounted-at` stamp is present. A NEW serve line for that id appears per attempt (per the **Serve-line receipt** above — `<env-root>/logs/dev-env-stdout.log` primary; an absent line from both instruments is an ARTIFACT defect, never a row downgrade); the host process PIDs are unchanged before/after (no host restart); the window label stays `installed-<id>`; other windows are untouched. The second cycle repeats the whole shape (so a one-shot in-memory fluke cannot pass it).
  - **DATA:** fail-once fixture (`build-behaviour-fixtures.mjs`, ST-7). Its "once" is per browsing context — `location.reload()` reuses the context, so a `sessionStorage` counter is the intended lever; verify the lever from the fixture source before judging the row.
  - **EDGE:** a retry that reloads the HOST (main window tears down, its unsaved state lost) is a FAIL of containment, not merely of the retry; a retry that only re-renders the failure panel is a FAIL; if the fixture's per-document lever does not work under real reload semantics, record it as an ARTIFACT defect and report it — do not silently swap in "the retry was attempted".

- [ ] **F-4.4 (R-4.4) [live+static]** — install the valid package, then mutate one byte of a file under `<FREDO_DATA_DIR>/installed-apps/<id>/files/` (or use the hash-tamper fixture), then open it **from the launcher**.
  - **EXPECTED:** AC-4 verbatim — *"refuse to load it and report that specific failure"*: the launcher renders `[data-testid="launcher-installed-app-error"]` (`role="alert"`) with `data-refusal-code="integrity_mismatch"` and the F7 sentence — load-time codes render on the LAUNCHER surface, never in the settings pane. **No `installed-<id>` window is created** (`tauri_manage_window list` unchanged) and the mutated bytes are never served. Static clause: `scheme.rs` reads each requested file ONCE and hashes that SAME buffer before serving it — no read-twice / verify-then-open path (CWE-367).
  - **EDGE:** a window that opens showing the mutated content is a FAIL; a mismatch that only logs (no refusal) is a FAIL; a mismatch rendered in the SETTINGS pane is a FAIL of the one-surface-per-code rule. The block is not sticky — restore the bytes, re-open, and the app loads.

- [ ] **F-4.5 (R-4.4) [live]** — corrupt `<FREDO_DATA_DIR>/installed-apps/<id>/record.json` (truncate it to 0 bytes), then open the app from the launcher.
  - **EXPECTED:** `launcher-installed-app-error` with `data-refusal-code="integrity_record_corrupt"` (the specific code, not a generic `io_error`), no window created, and the other installed apps still open (per-app corruption, per-directory registry).
  - **EDGE:** a record corruption that silently downgrades to `id_not_installed` hides the failure — record the code actually rendered.

- [ ] **F-4.6 (R-4.5) [live]** — with an installed crash/hang app failing AND a built-in window open with unsaved user input (e.g. typed text in the launcher searchbox and/or a Terminal session with pending input), observe both.
  - **EXPECTED:** AC-4 verbatim — *"other open applications and unsaved work are unaffected"*: the built-in window still renders and responds, the typed text is still present verbatim, the built-in window's label/geometry is unchanged, and the host PID is unchanged.
  - **EDGE:** a failure that closes/refreshes the other windows is a FAIL; a focus steal that discards the unsaved text is a FAIL.

## AC-5 — lazy start, lazy re-open (R-5.1 … R-5.5)

- [ ] **F-5.1 (R-5.1) [live — POSITIVE DISCRIMINATOR]** — with at least one installed app present and **never opened in this host process**, measure BEFORE any open:
  - (a) `tauri_manage_window action="list"` ⇒ **zero** windows whose label starts `installed-`;
  - (b) **zero** `fredoapp` serve lines for this boot, read per the **Serve-line receipt** above —
    primary: grep `<env-root>/logs/dev-env-stdout.log` for `fredoapp` and keep only current-boot lines;
    `tauri_read_logs(source="system", …)` only if that source exists in this driver (optional, never
    required). The scheme handler emits one line per served request — a host-side instrument that
    exists whether or not any app runs;
  - then open the lazy-trace app and re-measure both.
  - **EXPECTED:** AC-5 verbatim — *"no code from any installed application runs"*. Before: (a) and (b) are zero, and no `data-mounted-at` exists anywhere (no child document exists to carry it). After the first open: a `installed-<id>` window exists, ≥1 serve line for that id appears, and `[data-mounted-at]` on `installed-app-root` is a non-empty timestamp. That pair is the discriminator: the marker can only exist after a first open, and the serve line is read from the HOST, not from the child it would deny. If neither serve instrument yields a line at all, that is an **ARTIFACT defect to report** — never a PASS and never a downgrade of the row.
  - **EDGE:** a screenshot offered as proof of absence is not evidence (G-408) — the row is the zero-count + the positive marker only. A boot that pre-creates the window is a FAIL. An IPC capture is neither required nor admissible as the proof: `logic-verified — invoke not observable through the monitor in this build` (G-3098).

- [ ] **F-5.2 (R-5.2) [live]** — open the **hang-on-load app** (a stable ~10 s observation window) and poll at 50 ms for `[data-testid="installed-app-loading"]`; corroborate with the valid app (a fast load still shows the panel on at least one poll).
  - **EXPECTED:** AC-5 verbatim — *"they see a loading state until it is usable"*: `installed-app-loading` is visible BEFORE the app is usable, is `role="status"` `aria-live="polite"` with accessible name **"Loading <displayName>"**, and disappears (valid app) or is replaced by the failure panel (hang) — never both at once.
  - **EDGE:** a loading panel that never disappears on a healthy app is a FAIL; a frozen host (no repaint) during the load is a FAIL of the performance axis (N-3).

- [ ] **F-5.3 (R-5.3) [live]** — open the lazy-trace app, record its `data-mounted-at`, then close the window (host `installed_app_close` or the window control).
  - **EXPECTED:** AC-5 verbatim — *"the application stops running"*: `tauri_manage_window list` no longer lists `installed-<id>`; a DOM/`execute_js` read against that `windowId` fails (the JS context is gone); and the recorded mount stamp cannot be read afterwards. State explicitly that the discriminator is the destroyed browsing context.
  - **EDGE:** a closed window whose label lingers in the list is a FAIL; a "close" that only hides the window (still executable) is a FAIL.

- [ ] **F-5.4 (R-5.4) [live]** — re-open the same app after the close, without restarting the host.
  - **EXPECTED:** AC-5 verbatim — *"opening it again works without restarting Fredo"*: the window reappears, `[data-mounted-at]` is a **NEW** value (a fresh document, not a reused context), the host process PID is unchanged, and the host log shows a new serve line (per the **Serve-line receipt** above).
  - **EDGE:** re-open → close → re-open three times: each mount stamp differs; no `Maximum update depth exceeded`; no duplicate `installed-<id>` window.

- [ ] **F-5.5 (R-5.5) [static+live]** — startup work with a **0-installed-apps** control (clean env) vs **≥5 installed apps**, both never opened. The observable is *"no work proportional to the number of installed applications happens at startup"*.
  - **GATE LEG 1 — `[static]` setup-block read.** Read `apps/tauri/src-tauri/src/lib.rs`: the `builder.setup(|app| { … })` closure (opens at `lib.rs:189`) plus the module-declaration / `generate_handler!` registration regions. Assert it performs **no** installed-apps read, listing, or window creation. **Quote** every installed-apps-relevant line of the setup region, or state "**zero hits**" and name the tokens searched: `installed_app`, `installed-apps`, `installed_apps_list`, `InstalledAppStore`, `list_installed`, `installed_app_window_label`, `open_installed_app_window`, `WebviewUrl::External`. An `installed-` window created, a `<id>/manifest.json` read, or a directory listing of `installed-apps/` inside the setup closure is a **FAIL**.
  - **GATE LEG 2 — `[live]` host-side positive instrument** (the same discriminator F-5.1 uses). With **≥5** installed apps present and **none opened in this boot**, and **before any open**: (a) `tauri_manage_window action="list"` ⇒ **zero** entries whose label starts `installed-`; (b) **zero** `fredoapp` serve lines for this boot, read per the **Serve-line receipt** above. That is "no work proportional to count" observed from host-side instruments — never from the child.
  - **CORROBORATION — explicitly NON-GATING.** Quote the host boot→first-paint wall clock for the 0-installed control and for the ≥5-installed state across **≥3 repeats**, with the spread. **Invent no threshold**: timing is never the verdict.
  - **NAMED LIMITATION (pre-authorized, G-3098).** An IPC-level boot capture is **unavailable in this build** — `logic-verified — invoke not observable through the monitor in this build` (the adapter's ES-module `invoke` bypasses both `tauri_ipc_monitor` and a runtime wrapper on the internal handle; `references.md:43`). The structural claim is therefore carried **only** by gate leg 1 (static) + gate leg 2 (the two live absence instruments), and **never** by an IPC capture.
  - **EXPECTED:** AC-5 verbatim — *"Fredo's startup cost SHALL NOT grow with the number of installed applications"*. Both gate legs must pass; the timing numbers are quoted as corroboration and are never rounded into a verdict.
  - **EDGE:** a boot that lists installed apps to populate a UI is a FAIL even if fast; a `[static]` leg answered by a live observation (or a `[live]` leg answered by reading source) is a PASS-by-substitution and is **not** a PASS; timing noise must never be reported as growth, or as absence of growth, without both gate legs. A verdict claiming an IPC capture as this row's proof is malformed on its face.

## Refusal matrix (the 22-code set — one family per live leg, all codes pinned)

> The live rows above drive **one refusal per FAMILY** through the UI and read the rendered reason.
> The full 22-code set is a **unit pin**, not a rendered sweep: the value of the live legs is that the
> refusal surface really renders a specific sentence, and the value of the pin is that no code can ship
> without its own distinct copy. Both are required; neither substitutes for the other.

| Family | Codes | Live leg that drives it | Unit pin |
|---|---|---|---|
| archive | `not_a_zip` | F-6.1 | F-6.2 |
| F1 not-a-package | `no_manifest` | F-3.1 | F-6.2 |
| F2 package-description-rejected | `manifest_malformed`, `manifest_unknown_field`, `manifest_invalid_field`, `unsupported_manifest_version` | F-3.2 (whichever the fixture produces) | F-6.2 |
| F2 identity | `id_invalid`, `id_reserved`, `version_invalid` | F-6.1 (upper-case id) | F-6.2 |
| F3 not-compatible | `engines_range_invalid`, `host_incompatible` | F-3.3 | F-6.2 |
| F2 entry | `entry_missing`, `entry_invalid` | F-6.1 (entry names an absent file) | F-6.2 |
| F4 archive-refused | `unsafe_path`, `reserved_path` | F-3.4, F-3.5 | F-6.2 |
| F4 budget | `archive_too_large` | F-3.5 (unit boundary) | F-6.2 |
| F5 already-installed | `already_installed` | F-3.6 | F-6.2 |
| F6 install-did-not-complete | `io_error` | F-6.4 (pane list-load-failure path) | F-6.2 |
| F7 damaged-after-install | `integrity_mismatch`, `integrity_record_corrupt` | F-4.4, F-4.5 | F-6.2 |
| F8 nothing-there | `id_not_installed`, `id_is_installed_app` | F-6.1 (d) | F-6.2 |

> **One surface per code** (UI/UX §2): F1–F6 render in the settings pane
> (`installed-apps-refusal`), F7–F8 render on the LAUNCHER (`launcher-installed-app-error`) because
> an integrity refusal creates **no window** — there is no child document to carry the message. A code
> rendered in both surfaces, or in the wrong one, is a FAIL of the matrix.

- [ ] **F-6.1 (R-3.1/R-3.2 family sweep) [live]** — drive four cheap extra refusals through the SAME surfaces: (a) a plain non-zip file renamed `.zip` ⇒ `not_a_zip`; (b) a manifest with an upper-case `id` ⇒ `id_invalid`; (c) a manifest whose `entry.module` names an absent file ⇒ `entry_missing`; (d) two LAUNCHER-side open refusals — `installed_app_open{appId:"qa3147-does-not-exist"}` ⇒ `launcher-installed-app-error[data-refusal-code="id_not_installed"]`, and `installed_app_open{appId:"terminal"}` (a built-in id) ⇒ `id_is_installed_app`.
  - **EXPECTED:** each install refusal's `data-refusal-code` equals the code named here and
    `installed-apps-refusal-reason` equals `INSTALL_REFUSAL_COPY[code]` verbatim (quote the sentence
    from `refusals.ts`); the three install refusals leave the install root unchanged (no new `<id>/`).
    Each OPEN refusal renders in `launcher-installed-app-error` (never the settings pane) with its own
    code and sentence, and creates no window.
  - **DATA:** (a)/(b)/(c) need hand-authored zips under `.opencode/tmp/3147/` (plain
    `Compress-Archive`); (d) needs no fixture.
  - **EDGE:** `id_not_installed` vs `id_is_installed_app` are DIFFERENT lookups — confirm the
    built-in id is refused with the second code, not the first. The launcher block is not sticky —
    it clears on the next activation attempt.

- [ ] **F-6.3 (R-1.1/R-1.2) [live]** — the two UI/UX-added pane states. (a) On a **clean install
  root**, open the pane: `[data-testid="installed-apps-empty"]` renders `role="status"` with
  "No applications installed yet."; `[data-testid="installed-apps-list"]` is **absent** (the shipped
  absence rule — not an empty `<ul>` beside a message); the install button is still focusable above
  it. (b) With ≥1 app installed, `[data-testid="installed-apps-limitations"]` renders the v1-limitation
  block (always visible, not dismissible).
  - **EXPECTED:** (a) the empty state renders exactly once and announces once (no live-region spam);
    (b) the block's text states that installed apps open in their own window, cannot be placed as
    in-window panels, and take no part in Fredo's keyboard navigation; the trust line
    ("Fredo doesn't verify who built a package. Install only packages you trust.") is visible under
    the install button and contains no verification vocabulary ("verified"/"signed"/"publisher"/
    "trusted author").
  - **EDGE:** neither hook may be a tab stop (Tab from the install button must not land on either); an
    empty `<ul>` alongside the empty message is a FAIL; a limitations/trust block implying provenance
    verification is a FAIL.

- [ ] **F-6.4 (R-3.5 / F6) [live]** — make the pane's list fetch fail: with the app installed, put a
  non-directory file where a listing entry must be (or make `<FREDO_DATA_DIR>/installed-apps/<id>/manifest.json`
  unreadable) and re-open the pane.
  - **EXPECTED:** the pane is **not blank** — it renders the refusal block with
    `data-refusal-code="io_error"` (UI/UX §3.1's specified code) and a reason sentence read from
    `INSTALL_REFUSAL_COPY` for that code, and the empty state (`installed-apps-empty`) does NOT render
    (that is reserved for a genuinely empty registry). A failed list fetch is a verdict, never
    emptiness.
  - **EDGE:** a blank pane or a spinner that never resolves is a FAIL; an `io_error` block rendered
    as the empty state is a FAIL (two different facts must not share one surface); a refusal that
    leaves the install button disabled forever fails R-3.5 too.
  - **Known open copy issue (not the tester's to adjudicate):** UI/UX's `io_error` sentence reads
    "Fredo couldn't finish *writing* that package to disk", which is wrong for this READ path. Record
    the sentence and whether it matches the map entry; if UI/UX resolves it by re-coding the
    read-failure (23rd code) or splitting the sentence, re-derive this row (G-136) — do **not** FAIL
    the row for the wording.

- [ ] **F-6.2 (R-3.1/R-3.2 family sweep) [unit]** — the copy map completeness pin:
  `pnpm --filter @fredo/ui test:run <the INSTALL_REFUSAL_COPY test>` (quote the test's file path from
  the spec branch — do not invent it).
  - **EXPECTED:** the test enumerates **all 22 codes** (count them in the test source and quote the
    count) and asserts each maps to a **distinct, non-empty** sentence; quote the test name verbatim
    from the committed source (G-419 — grep the title, do not paraphrase).
  - **EDGE:** a test that only asserts "no empty string" without distinctness passes two codes sharing
    one sentence — record whether distinctness is actually asserted; if not, it is a suite defect to
    report, not a PASS.

## Non-functional rows

- [ ] **N-1 Security [static+live]** — the child document's policy is authored by OUR handler (`scheme.rs`) and is exactly
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ipc: http://ipc.localhost; base-uri 'none'; form-action 'none'`
  (asserted as an exact string by a `scheme.rs` unit test — quote it); `apps/tauri/src-tauri/tauri.conf.json` is **unmodified** by this spec (`app.security.csp` / `devCsp` / `withGlobalTauri: false` byte-identical to the pre-change file).
  **EXPECTED:** string equality with the authored policy; and F-2.2's rejection is an ACL error, not a CSP/network error — proving `connect-src` kept the IPC transport reachable so the refusal is the ACL's.
  **EDGE:** any `tauri.conf.json` edit is a FAIL (the CSP path is per-document, not global).

- [ ] **N-2 Integrity [static+live]** — the two integrity axes: (a) install-time — `record.json` carries `{path, sha256, bytes}` per regular file sorted by path plus an aggregate digest (read one installed `record.json` and verify each hash matches the file on disk, computed independently); (b) load-time — F-4.4's mismatch refusal.
  **EXPECTED:** every recorded hash recomputed from disk matches; the aggregate digest covers the sorted file set; a mismatch is `integrity_mismatch` with no window created.
  **EDGE:** a record that omits a file present on disk is a FAIL (an unrecorded file must never be served).

- [ ] **N-3 Performance [live]** — "first open shows loading, not frozen": during F-5.2's hang window, interact with the host (focus the launcher searchbox, type) and screenshot the child.
  **EXPECTED:** the host responds within ~1 s to each interaction while the child loads; the child paints the loading panel (not a blank frame); the host main window never shows a spinner/hang.
  **EDGE:** the host repainting but its IPC dead (window list times out) is a FAIL.

- [ ] **N-4 Failure containment [live]** — see F-4.1…F-4.6; the consolidated check is that after each failure leg, `tauri_manage_window list` answers, the host PID is unchanged, and no other app's window was closed or reloaded.
  **EXPECTED:** containment holds on every failure path (crash, timeout, integrity mismatch, corrupt record).
  **EDGE:** a failure that leaks into the host console as `Uncaught` from the child's document is a FAIL.

- [ ] **N-5 Theming (tokens, not hardcoded) [static+live]** — the HOST-authored installed-app surfaces (`bootstrap.js` loading/failure panels + the serve-time `<style>`) must contain **zero** hardcoded hex/rgb/hsl colour literals and reference only `var(--…)`; the served document's `<style>` must declare the mirror's token names/values.
  **EXPECTED:** a comment- and string-stripped scan of `bootstrap.js` yields zero colour literals (report the raw-token count too, G-419); the served `<style>` block's declarations equal the host's token set for the sample names; and the child visibly renders in the theme in F-1.4/F-1.5/F-1.6 (screenshot corroboration).
  **EDGE:** `transparent`/`inherit`/`currentColor`/`none` are allowed literals; an alpha-append onto a `var()` (e.g. `var(--accent-primary)22`) is a FAIL (invalid CSS).

- [ ] **N-6 Build hygiene [gate]** — run and quote exit codes:
  - `pnpm --filter @fredo/ui build` ⇒ exit `0`, no TypeScript errors;
  - `cargo check --locked` in `apps/tauri/src-tauri` ⇒ exit `0` with **zero** `warning:` lines;
  - `cargo test --lib --locked` ⇒ exit `0` (disclose a `cargo test` substitution if `nextest` is absent, G-282);
  - `pnpm --filter @fredo/ui test:run` ⇒ exit `0`.
  **EXPECTED:** all four green; no `#[allow(...)]` added to silence a warning.
  **EDGE:** use `run-exitcode.ps1 -Command "<cmd>"` to obtain `EXITCODE=` in this sandbox; a Rust test leg needs the dev env `Down` first (the running `fredo.exe` locks the target binary).

- [ ] **N-7 Accessibility [static+live]** — read `bootstrap.js` for the declared semantics, then read the RENDERED attributes in the child/host.
  **EXPECTED (verbatim from the names block):** `installed-app-loading` is `role="status"` `aria-live="polite"` named **"Loading <displayName>"**; `installed-app-failure` is `role="alert"` `aria-live="assertive"` with heading **"Couldn't open <displayName>"**; `installed-app-retry` is a text button **"Try again"**; `installed-app-failure-reason` carries the reason as text; host `installed-apps-refusal` is `role="alert"`. Confirm via an accessibility snapshot that each name is announced — and that the reason is never carried by colour alone.
  **EDGE:** `aria-live="polite"` on the failure panel or `assertive` on the loading panel is a FAIL (swapped politeness); a `<div>` with a click handler instead of a real `<button>` for retry is a FAIL.

## Pass / fail criteria

1. A row PASSES only when every clause of its EXPECTED is observed in the SAME round, with the
   observed values/file:line quoted. A row missing its required fixture, or whose env leg is
   blocked, is recorded **UNVERIFIED + named blocker** — never a PASS and never a silent skip.
2. **No PASS by substitution:** a static row may not be answered by a live observation of a
   neighbouring surface, and a live row may not be answered by reading source. Each row declares
   its evidence kind in brackets — honour it.
3. Every AC-N row group must be all-PASS for that AC to pass. One FAIL inside a group fails the AC.
4. `[static]` rows quote the exact file + the assertion (a grep count, an enumerations listing, a
   unit-test name). `[live]` rows quote the observable value (DOM read, `getComputedStyle` string,
   measured ms, window label, log line).
5. Zero tolerances invented at test time: any numeric band in this suite is either copied from the
   Architect's names block or declared here. If a band is missing, record the measurement and
   report the gap — do not adjudicate it into a verdict.
5a. **No row in this suite uses `tauri_ipc_monitor`, and no row may be answered by one.** The monitor
   cannot witness application invokes in this build (G-3098 — `references.md:43`): the adapter issues
   its invokes through an ES-module `invoke`, which bypasses both the monitor and a runtime wrapper on
   the internal handle. F-5.5's boot leg was the only candidate and it is carried instead by the
   static setup-block read plus the two host-side absence instruments, with the named limitation
   `logic-verified — invoke not observable through the monitor in this build` pre-authorized in the
   row. An IPC capture offered as a PASS's proof is malformed on its face.
6. Every evidence artifact named in the verdict must be a **NON-DRAFT record** — the posted
   `## Tests Runs` comment or a committed/non-consumed path. A `.opencode/tmp/3147/` timeline draft
   (dev summary, triage plan, fix plan) is consumed by the transition and is never the record
   (G-415). Screenshots live under `.opencode/tmp/3147/e2e/` and are uploaded to
   `user-attachments` before the verdict.

## Required test data

| # | Artifact | Owner | Notes |
|---|---|---|---|
| 1 | valid / no-manifest / bad-manifest / zip-slip / hash-tamper **/ incompatible-`engines.fredo` / reserved-`__fredo/`** packages + expected-output manifest | **ST-2** `build-package-fixtures.mjs` (all seven named in its Work line) | run once; record the output dir + the manifest's codes |
| 2 | probe app · lazy-trace app · crash-on-load app · hang-on-load app · **fail-once-then-mount app** | **ST-7** `build-behaviour-fixtures.mjs` (all five named in its Work line) | probe must expose `[data-probe-result]`/`[data-probe-error]`; fail-once needs the `sessionStorage` counter lever |
| 3 | incompatible-`engines.fredo` package · reserved-`__fredo/` package | **ST-2** (same Work line as the other five packages — owned, not an outside request) | needed by F-3.3 / F-3.5 — no row may PASS by substituting another family member |
| 4 | a non-default accent value and the presets `Light Default` / `Dark` | shipped (`Theme presets` select, `Primary color` input) | no fixture needed |
| 5 | host command pair `save_control_setting` + `get_control_setting` | shipped (`lib.rs` generate_handler) | the R-2.2 non-vacuity control |
| 6 | a mutable install root under `.opencode/*` | `FREDO_DATA_DIR` from the env manifest | needed for the integrity legs (F-4.4/F-4.5) |

## Non-functional checks

Security (N-1, F-2.2, F-2.5, F-2.6) · Integrity (N-2, F-4.4, F-4.5) · Performance (N-3, F-5.5) ·
Failure containment (N-4, F-4.1…F-4.6) · Theming (N-5, F-1.4…F-1.8) · Build hygiene (N-6) ·
Accessibility (N-7, F-5.2, F-4.1).

**E-SPAN is a NAMED BLOCKER on every live row**: this feature runs no OTLP producer of its own, so a
missing PostgreSQL port is recorded once, up front, and never retried per row.
