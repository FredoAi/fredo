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
> **#3146 EXTENDED THIS SUITE (in place — the #3147 rows above keep their ids and their subjects).**
> The group **AC-6 — declared reach, undeclared refusal, data ownership, consent, identity** adds
> F-7.1 … F-7.28 for *"an installed application reaches only the backend surface it declared."* Two
> #3147 rows were **inverted in place** because #3146 supersedes the property they asserted, without
> changing their subjects: **F-2.5** (zero capability files match `installed-*` → exactly ONE matches,
> granting exactly one permission) and **F-2.6** (no pattern can ever match `installed-…` → exactly one
> pattern family matches it, with the reciprocal direction asserted). F-1.2's `capabilities` INERT note
> is now **live**. **F-2.2 is NOT inverted** — its expectation (raw command names are ACL-refused) is
> still exactly right, because the installed tier still grants exactly one command.
>
> **#3145 EXTENDED THIS SUITE AGAIN (in place — every earlier row keeps its id and its subject).**
> The group **AC-8 — the authoring kit: build outside the repo, and it installs (#3145)** adds
> F-8.1 … F-8.26 for *"an application author outside the Fredo team can build a Fredo application
> and load it into their own Fredo"* — the published `@fredo/theme` / `@fredo/authoring` packages,
> the authoring documentation and its claim allowlist, the external-developer exam, and the two
> artefact drifts that contradict what ships. **Development mode is NOT in this suite's scope**: it
> moved to **#3241** carrying AC 3 verbatim (criteria 18). F-8.23…F-8.26 were bound against the
> **UI/UX Expert's** colour-contract design (its §1 class legend, §2 C1/C2/C3 comparison classes and
> §3 overclaim list) — the readout grammar those rows cite is the UI/UX one, adopted verbatim so the
> fixture is authored once.
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
| Child window | `tauri_manage_window action="list"` label `installed-<id>`; the window's OS title is the app's `displayName` |
| **Child evidence read** | **`tauri_webview_*` CANNOT reach the child** — `execute_js` / `dom_snapshot` / `find_element` / `screenshot` / `console` all return `Request timeout after 2000ms` against `installed-<id>` (#3147, re-observed #3146 round 1). Child evidence is read with a **capability-independent instrument**: a **native accessibility (UIA) text read of the `installed-<id>` window's own a11y tree**, corroborated by a **native window capture**. See "Child evidence transport" below |
| Host log | **Serve-line receipt (primary):** grep `<env-root>/logs/dev-env-stdout.log` for `fredoapp`, current boot only (documented direct read path — `dev-environment` SKILL.md:234). **Secondary, only if that source exists in this driver:** `tauri_read_logs(source="system", …)` — optional, never required (only `source="console"` is documented). Neither yields a line ⇒ **ARTIFACT defect to report to the Orchestrator**, never a PASS and never a row downgrade |
| Install root | the env lease's `FREDO_DATA_DIR` (default `<env-root>/data`) + `/installed-apps/` |
| First paint | a fresh isolated boot may take 3–5 min (G-386) — wait it out, do not call it a wedge |
| Pre-flight | `pnpm install --frozen-lockfile` if the spec added a UI dependency; check `resolveRef` (G-067) before any ref-based drive |

## Child evidence transport — the rendered-text mirror (READ THIS FIRST)

> **Why this section exists.** The installed window is **unreachable by every `tauri_webview_*` tool**.
> The bridge's injected `execute_js` *lands* (`window.eval` runs) but its **result channel** is
> ACL-denied inside the child — the wrapper calls `window.__TAURI__.core.invoke('plugin:mcp-bridge|
> script_result', …)`, and the child has neither `__TAURI__` (`withGlobalTauri:false`) nor a grant
> for that command. Every `execute_js` / `dom_snapshot` / `find_element` / `screenshot` / `console`
> call against an `installed-*` windowId returns **`Request timeout after 2000ms`** (#3147 round 1,
> unchanged in #3146). **This is not a workaround of a product bug — it is the feature working.**
>
> **So the fixtures drive themselves.** Every openable package from
> `build-capability-fixtures.mjs` runs its own probe plan on `mount` and **mirrors every result as
> rendered text**. The tester never injects anything into the child.
>
> **How to read it (the ONE host-side instrument).**
> 1. `tauri_manage_window action="list"` → find `installed-<id>`, confirm its OS title is the app's
>    `displayName` (that is how you know which window you are reading).
> 2. **Native UIA text read** of that window's own accessibility tree (`UIAutomation` / `GetWindowRect`
>    on the `Tauri Window` HWND that hosts the child webview) — quote the text nodes you read.
> 3. **Corroborate with a native capture** (`PrintWindow` / OS screenshot of that window) saved under
>    `.opencode/tmp/3146/e2e/` and uploaded with `upload-evidence` (it becomes a `user-attachments`
>    URL). A capture must show the whole assertion block, uncut.
> 4. **Never** call `tauri_webview_execute_js` / `dom_snapshot` / `screenshot` with
>    `windowId="installed-<id>"` and treat the timeout as evidence — it times out against a *healthy*
>    child too, so it proves nothing in either direction.
>
> **The mirror selectors and their exact text (this is what each row cites).**
>
> | Selector | Exact rendered text |
> |---|---|
> | `[data-qa3146-header]` | `QA3146-FIXTURE app=<id> version=<v> capabilities=<set> tables=<csv> probes=<ids>` — **identical on every run**; assert it names the app you meant to read |
> | `[data-qa3146-document]` | `QA3146-DOCUMENT app=<id> version=<v> ready=true mount=<id> loaded=<iso> origin=<origin>` — the per-document line; `mount=` is the reload discriminator |
> | `[data-qa3146-theme]` | `QA3146-THEME theme.body-bg=<v> theme.card-bg=<v> theme.text-primary=<v> theme.accent-primary=<v> colorScheme=<light\|dark> mount=<id>` — **re-published every second**, so a live theme push is observable against an unchanged `mount=` (F-1.4 … F-1.8) |
> | `[data-qa3146-assertions]` | one line per assertion: `PASS <id> codes=<c1>,<c2> …` or `FAIL <id> codes=… <reason>` — `<id>` is the **row id** (e.g. `F-7.13`), `codes=` carries the refusal code of each step **in drive order** (`ok` for a resolve) |
> | `[data-qa3146-consent]` | `QA3146-CONSENT app=<id> mount=<id> state=<consent\|granted> query=<code>` — live consent state (consent fixtures only; `state=none` elsewhere) |
> | `[data-refusal-code]` | the last refusal code, as text |
> | `[data-refusal-json]` | the last refusal, verbatim JSON text — **only the LAST one the document made**; for a specific call read that call's entry in `[data-call-log]` (every `ok:false` entry carries its full `refusal`) |
> | `[data-call-log]` | every call in drive order, JSON |
> | `[data-qa3146-summary]` | `QA3146-SUMMARY calls=<n> rejected=<n> probes=<n> done=<true\|halted\|running>` |
>
> Three of those ids are the mirror's **own controls, not rows**: `HDR` (the runtime app id/version
> matched the manifest), `RELOAD` (a `FAIL` means the document was reloaded inside one window — the
> discriminator F-7.18/F-7.27 read) and `RUNNER` (the probe runner threw — treat the instrument as
> dead). Record them; do not grade them as product rows.
>
> **The negative control (mandatory, same round).** `qa3146-mirror-control` installs and opens like
> any other package, but its single probe carries a **knowingly false** expectation, so a working
> mirror **must** print
> `FAIL MIRROR-CONTROL codes=ok step 1 expected refusal action_not_declared, resolved`.
> - line **missing** ⇒ the mirror never ran (nothing about the child is evidence);
> - line reads **PASS** ⇒ either the declared read really was refused (a product defect) or the
>   mirror is fabricating results;
> - line reads **FAIL with that reason** ⇒ the transport is live and the other lines can be trusted.
>
> **Two limits the verdict must state (they are not negotiable).**
> - A **native/UIA read is not a live-evidence token** for the pipeline's `testing → audit` matcher
>   (which accepts `telemetry_spans`, `user-attachments`, `tauri_webview_*`, `getBoundingClientRect`).
>   So the verdict **must also carry one genuine `tauri_webview_*` receipt from a REACHABLE window**
>   (`main` / `app-*`) in the same round, or the leg is **refused for an instrument reason** — never
>   upgraded to a PASS on a native read alone, and never failed as a product row. The
>   `user-attachments` upload of the native capture is the admissible image token.
> - The **host-side child read/inject path** (a bridge that can read or drive an `installed-*`
>   document) is a **Toolsmith** item. It is **routed and non-gating this round**: no row may block on
>   it, and no row may be answered by an improvised one-off script.

---

## Fixtures (three committed generators, deterministic, Node built-ins only)

| Generator | Owner | Emits |
|---|---|---|
| `.opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs` | ST-2 (#3147) | valid package, no-manifest package, bad-manifest package, zip-slip package, hash-tamper package (+ committed expected-output manifest naming each id/code) |
| `.opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs` | ST-7 (#3147) | probe app (invokes a real shipped command), lazy-trace app (`mount` stamps `data-mounted-at`), crash-on-load app, hang-on-load app, **fail-once-then-mount app** (throws on the first document load, mounts normally on the second — `sessionStorage` survives `location.reload()` within one window, so a per-document counter is the lever) |
| `.opencode/tests/installable-apps/fixtures/build-capability-fixtures.mjs` | **QA Expert (#3146)** | **eleven packages**: `qa3146-app-a` (`data.tables{notes, shared_log}`), `qa3146-app-b` (`data.tables{records}`), `mission` (`data.tables{monitor_sessions}` — the named collision), `orbit` (`data.tables{lab_notes, orbit_own}` — the constructed collision + its discriminator), `orbit-lab` (`data.tables{notes}`), `qa3146-consent-a` (query + reset), `qa3146-consent-b` (query only), `qa3146-no-capabilities` (no key at all), **`qa3146-mirror-control` (the NEGATIVE CONTROL — must print a `FAIL` line)**, plus two **expected-refusal** packages (`qa3146-source-projection`, `qa3146-unknown-capability`). **Every openable one is SELF-DRIVING**: its module runs its own probe plan on `mount` and renders the header / per-assertion `PASS <id>` / `FAIL <id> <reason>` lines / consent state / call record as visible text (see **Child evidence transport**), so a host-side native read scores it with no `execute_js` |

Run each generator once before the round and record its output directory in the verdict. **Every
generator's full package/app list is an explicit deliverable** (G-409 — nothing this suite requires is
owned nowhere):

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
- `build-capability-fixtures.mjs` (**#3146, authored WITH this suite by the QA Expert — committed by
  `tests-commit`**) emits the eleven packages in the table above and **self-checks every archive** before
  writing it (re-parse, CRC, manifest + `capabilities` round-trip, mount export, the exact
  capability defect at the exact field path for each of the two refusal fixtures, **and — for every
  self-driving fixture — that each probe id it advertises is embedded in `main.js` and that the
  rendered-mirror hooks exist**) and exits non-zero on any problem. It commits **no** hash manifest —
  so nothing can go stale — and proves determinism by a **twice-run `sha256` comparison**, which the
  round records. **Why a third generator and not an extension of the second:** `build-behaviour-fixtures.mjs`
  ships a committed sha256 manifest whose `--verify` mode fails when a built fixture is missing from it,
  so adding archives there reddens a committed gate until someone re-runs `--write-expected`; the QA
  Expert who authored these holds no shell (G-460) and will not ship hashes it cannot derive. Use
  `CAPABILITY-FIXTURES.txt` / `CAPABILITY-FIXTURES.json` from the output directory as the record of
  ids, filenames, expected refusal field paths, **per-fixture `probeIds`**, and the
  `mirror` block (the exact rendered-text grammar the rows cite). **The generator must be run on the
  spec tip after any edit to it**: a stale output directory would launch documents whose probe plan
  no longer matches `CAPABILITY-FIXTURES.json`.

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
  - **EXPECTED:** the projection carries **identity** (`id`, `displayName`), **compatibility** (`enginesFredo`, the declared range verbatim — never a boolean), `version`, `installedAt` (RFC 3339), `windowLabel` = `installed-<id>`, and **`capabilities`** (`InstalledAppCapabilityStatus { appId, declared, highRisk, consented }` — always present, all three arrays sorted, all three EMPTY for an undeclared package). ✅ **LIVE SINCE #3146** (supersedes the #3147 INERT note). In `manifestVersion: 1` a package may now declare `capabilities`; #3146 added the key, the projection field and the consent store, so the projection's capability axis is asserted by **F-7.16 / F-7.26** (this row only re-reads it as part of the projection shape). The **`needs` field remains structurally absent in `manifestVersion: 1`** — it is a DIFFERENT, still-unrealized declaration axis and is deliberately NOT part of #3146; do not demand it here.
  - **EDGE:** a projection that only carries identity is a FAIL of the compatibility axis. An absent **`capabilities`** key on the projection is now a **FAIL** (it is a shipped field since #3146). An absent **`needs`** key is NOT a defect (still inert by PO/Architect decision).

- [ ] **F-1.3 (R-1.2) [live]** — open the installed app from the launcher section (`[data-testid="launcher-installed-apps-section"]` → `[data-testid="launcher-installed-app"][data-app-id="<id>"]`), then repeat via `installed_app_open{appId}` from the host webview.
  - **EXPECTED:** a **new native window** appears (`tauri_manage_window action="list"` shows label `installed-<id>`); inside it `[data-testid="installed-app-root"]` is present and the fixture's own interface is visible (its authored DOM + screenshot); the window is NOT a host app window (`?view=app` route is absent) and carries no `app-*` label; the window's **OS title** is the app's `displayName`, not `installed-<id>` (UI/UX §3.4).
  - **EDGE:** opening an already-open app focuses the existing window instead of stacking a duplicate (`list` shows exactly one `installed-<id>`). **The settings pane deliberately has NO open control** (one open surface, one failure surface, UI/UX §3.1/§3.2) — a row asserting an Open button in the settings list is a FAIL of the design, not a product defect.

- [ ] **F-1.4 (R-1.3) [live] — LIGHT.** Set Settings → Appearance → `select[aria-label="Theme presets"]` to **`Light Default`** (`light-default`), open `qa3146-app-a`, then read `[data-qa3146-theme]` in the child (native UIA read / native capture) and compare its four token values with the same reads in the host.
  - **EXPECTED:** AC-1 verbatim — *"rendered with the user's currently active theme including light/dark and the user's accent"*. Per-token string equality host ↔ child for every token the line carries; every value **non-empty** (a literal `<empty>` is a FAIL); `colorScheme=light`.
  - **EDGE:** a token the child declares but the host omits is a FAIL; `<empty>` on both sides is a VACUOUS PASS and must be re-driven.

- [ ] **F-1.5 (R-1.3) [live] — DARK.** Same as F-1.4 with preset **`Dark`** (`dark`).
  - **EXPECTED:** identical read set, all non-empty, equal host ↔ child, `colorScheme=dark`, and the `theme.body-bg` value **differs from the F-1.4 light value** (positive discriminator: the appearance really travelled).
  - **EDGE:** a child that reports `colorScheme=dark` while its `theme.body-bg` is the light value is a FAIL of the derived-scheme rule.

- [ ] **F-1.6 (R-1.3) [live] — NON-DEFAULT ACCENT.** Restore a dark preset, then set `input[aria-label="Primary color"]` to a non-default accent (e.g. `#ff8800`), open the app, and compare `theme.accent-primary` / `theme.accent-secondary` host ↔ child.
  - **EXPECTED:** both strings equal host ↔ child, equal the override value, and **differ from the values observed in F-1.4/F-1.5** (so the accent is not a coincidentally-matching default). Capture the child as corroboration.
  - **EDGE:** an accent override applied while a Doom palette is active is a distinct state — record which palette governed and re-drive outside Doom mode.

- [ ] **F-1.7 (R-1.4) [live]** — with the app **closed**, change the preset (light → dark); then open it.
  - **EXPECTED:** the newly opened document's `[data-qa3146-theme]` carries the NEW values (equal to the host's post-change reads); the previous values are absent. This is the served-at-open moment — no IPC call is needed for correctness.
  - **EDGE:** open → close → change → re-open must reflect the change on the SECOND open, not only on the first (the document line's `mount=` differs between the two documents).

- [ ] **F-1.8 (R-1.5) [live]** — with `qa3146-app-a` **open**, record `[data-qa3146-theme]` (its four token values and its `mount=`), then change the accent in the host and re-read `[data-qa3146-theme]` with a bounded wait (≤ 10 s; the line republishes every second).
  - **EXPECTED:** the child's `theme.accent-primary` becomes the new value **and** the line's `mount=` is **UNCHANGED** from before the change (proves *without reloading it*). No `FAIL RELOAD document-reloaded …` line may appear (an in-window reload would be the FAIL).
  - **NAMED LIMITATION (pre-authorized, G-440).** A `fredo-theme-change` *listener* cannot be installed without the host-side inject path (a Toolsmith item, non-gating). The substantive clause — the new value arrives **without a reload**, proven by the unchanged `mount=` — is directly observed; the event-dispatch half is `logic-verified` against `bootstrap.js:183 dispatchThemeChange(theme)` and must be recorded as such, never upgraded to a PASS on a listener that was never installed.
  - **EDGE:** a change visible only after a reload is a FAIL of "without reloading" (and the `mount=` will show it); a change that republishes the same token is a FAIL of the token apply.

## AC-2 — isolation is real, built-ins unaffected (R-2.1 … R-2.4)

- [ ] **F-2.1 (R-2.1) [live]** — read the **child's own origin** from the fixture's document line (`[data-qa3146-document] … origin=<origin>`, rendered text read with a native UIA read / native capture; use `qa3146-app-a`), and read the host's `window.location.origin` from `main`.
  - **EXPECTED:** the two strings are **not equal** and the child's origin matches the platform form — this build is Windows, so `http://fredoapp.localhost` (macOS/Linux would be `fredoapp://localhost`). The host origin in a dev round is the Vite origin (`http://localhost:5174`) — whether you read the dev or the packaged origin, the assertion is **string inequality**, never a hardcoded host value.
  - **EDGE:** a child reporting an `about:blank` / empty / `unreadable` origin is a FAIL (an opaque origin would also refuse, but it would not be the served document) — corroborate with the same document's `ready=true` line and the `installed-<id>` window existing with the app's `displayName` as its OS title.

- [ ] **F-2.2 (R-2.2) [live]** — open the **probe app** (ST-7); its `mount` invokes TWO real shipped commands through `window.__TAURI_INTERNALS__.invoke(...)` and records the caught outcome on `[data-probe-result]` / `[data-probe-error]`. **Read those two nodes from the child's rendered text** (native UIA read / native capture — never `tauri_webview_execute_js`, see **Child evidence transport**):
  - (1) `save_control_setting` with key `qa3147-probe-child-<uuid>` (a **pre-existing** command with an observable side effect);
  - (2) `installed_apps_list` (a shipped installed-app command).
  - **EXPECTED:** AC-2 verbatim — *"its attempt to use Fredo's direct backend interface from inside the application is refused"*. BOTH invocations **reject**; the rejection is an **ACL / not-allowed authority error** (name the capability or the permission, not a network/`CSP`/`net::ERR` error); **and the handler did not run** — from the HOST, `get_control_setting{key: "qa3147-probe-child-<uuid>"}` returns `null`/`None` (no side effect exists), and no new entry appears in the install listing.
  - **NON-VACUITY CONTROL (mandatory, must be in the same round):** from `main`, invoke `save_control_setting{key:"qa3147-probe-host-<uuid>", value:"ok"}` then `get_control_setting` on that key ⇒ the value IS returned. This proves the command, the side effect and the read are all live, so the child's `null` means refusal, not a broken probe.
  - **DATA:** probe app + `get_control_setting` / `save_control_setting` on `main` (both registered, `lib.rs` generate_handler block).
  - **EDGE:** a network-level/CSP rejection instead of an ACL rejection is a FAIL of the sharper proof (the child document's `connect-src` deliberately keeps `ipc: http://ipc.localhost` reachable); a probe that reports success is a total FAIL of AC-2.
  - **SCOPE NOTE (#3146 — read before judging this row against F-7.x).** This row is the **ACL / least-privilege** row *by design*: it calls **raw command names** on purpose, because its subject is the installed tier's **command surface**, not the declared-reach feature. #3146 keeps its expectation intact — the tier still grants exactly ONE command (`installed_app_invoke`), so `save_control_setting` and `installed_apps_list` are still ACL-refused. Every #3146 capability row (F-7.5 … F-7.28) goes through the host-authored shim `window.__FREDO_INSTALLED__.invoke(action, args)` instead; a #3146 row that calls a raw command name is testing the ACL and is **not** a PASS of that row (F-7.10 is the one deliberate exception, and it says so).

- [ ] **F-2.3 (R-2.3) [live]** — open a built-in app that uses the shipped surface today (e.g. Database Client or Terminal from the launcher) and, from `main`, invoke a command the built-in UI uses today (`get_control_setting{key:"app_window_presentation"}`).
  - **EXPECTED:** AC-2 verbatim — *"the applications Fredo ships with continue to behave exactly as they do today"*: the built-in window opens and renders its content; the `main` invoke **succeeds** (not refused); the `app-*` window it creates is unaffected.
  - **EDGE:** a capability-denied error on ANY built-in window is a FAIL of this row and of `webview-security-boundary` R-1/R-3.

- [ ] **F-2.4 (R-2.3) [static+unit]** — the boot registry is unchanged: run `pnpm --filter @fredo/ui test:run src/applications/__tests__/retainedApplicationSet.test.ts`.
  - **EXPECTED:** all three cases green and the file **unmodified** by this spec (`it('registers exactly the eight retained features (no more, no fewer)')`; the pinned map is `wireframe, terminal, mission-monitor, database-client, theming, setup, settings, dev-mode`). Installed apps must not appear in `getApplications()` — grep `apps/ui/src/shared/installed-apps/` for `registerApplication(` = 0.
  - **EDGE:** editing that test (or registering an installed app through the registry) is a plan defect — report it, do not accept a "test updated" PASS.

- [ ] **F-2.5 (R-2.4) [static]** — **the installed tier's reach is exactly one command** (INVERTED IN PLACE by #3146; superseded property, same row id, same *reach* assertion).
  - **The property that changed, stated once.** #3147 shipped *"zero capability files match `installed-<id>` — an installed application matches NO capability."* #3146 **supersedes** that: the installed tier now reaches **exactly one** command (`installed_app_invoke`) through **exactly one** capability (`capabilities/installed-app-commands.json`, `windows: ["installed-*"]`, `permissions: ["allow-installed-app-invoke"]`), and **every other** capability still matches no installed label. Isolation is maintained by *cardinality plus exact-set*, not by zero.
  - **INSTRUMENT — a parsed-JSON matcher, NEVER a raw token grep.** Enumerate **every** file under `apps/tauri/src-tauri/capabilities/` with a **directory listing** (never a Glob; enumerate what you actually find, and the file COUNT is **not** the assertion — quote it as an observation). For each file, parse the JSON and glob-match the probe label `installed-<fixture id>` against every entry of its `windows` array **and** its `webviews` array. Put every filename AND every file's full `windows` array in the evidence with the per-file match result.
    **WHY NOT A GREP (G-430):** the shipped `installed-app-commands.json` **names** the installed namespace by design, so the literal `installed-` now legitimately returns ≥1 hit inside the scanned root. A raw-token predicate would either redden on a correct tree or be silently widened until it proved nothing. The predicate is therefore the PARSED matcher, and the matcher's probe label lives in the instrument (`.opencode/scripts/inspect-webview-config.ps1`) and in this suite — **neither of which is inside the scanned root** — so the instrument cannot count its own assertion text.
  - **EXPECTED (the binding, hard-FAIL assertions).**
    (1) **Exactly one** capability file's `windows`/`webviews` matches `installed-<probe>`; quote its filename and its full `windows` + `permissions` arrays.
    (2) That capability's `permissions` array is **exactly** `["allow-installed-app-invoke"]` — no second entry, no `core:*`, no wildcard entry, no `shell:*`. An entry that grants a *set* is a FAIL.
    (3) That capability's `windows` array is **exactly** `["installed-*"]`.
    (4) **Every other** capability file matches no installed label (and none reaches one through `webviews`). Quote the per-file matcher result beside that file's `windows` array.
    (5) Each file MUST declare its reach explicitly: an absent or empty `windows` **and** no `webviews` is a **FAIL of this row** (a capability whose reach cannot be read off its own declaration cannot be shown to exclude the installed class) — quote the whole file in that case.
    (6) Every *other* capability's `windows` array is exactly `["main","terminal","doom","app-*"]` or a strict subset of those four — quote them.
  - **NON-VACUITY CONTROLS (mandatory, same round — BOTH required):**
    (a) the matcher applied to `app-terminal` MATCHES `app-*` (the built-in class is reachable, so the matcher is not matching nothing);
    (b) the matcher applied to `installed-app-terminal` matches `installed-*` **and does NOT match `app-*`** — this is the control #3146 newly needs: an installed-tier matcher that also swallowed built-in labels, or a built-in matcher that also swallowed installed labels, would blur the two tiers while every count above still read correctly.
  - **DATA:** the committed guard is `.opencode/scripts/inspect-webview-config.ps1`, whose installed-reach check is **rewritten into this positive form by the Toolsmith** (it currently hard-FAILs any capability naming `installed-*`, which is correct for the pre-#3146 tree and wrong for this one). Quote the `CHECK <name>` line and its `Detail` **verbatim as shipped at the tested commit** (G-419 — read the `Add-Check '...'` token from the script; do not paraphrase it), and quote the script's `ExpectedCapabilities` set, which must now contain `installed-app-commands.json`. **Evidence allowlist (G-431):** the instrument itself (`.opencode/scripts/inspect-webview-config.ps1`), its documentation (`.opencode/skills/webview-security-evidence/SKILL.md`) and `.opencode/tests/**` are the only places allowed to name the installed namespace outside `capabilities/`; no product source may.
  - **EDGE:** a SECOND capability file matching `installed-*`, or the one matching capability carrying a permission beyond `allow-installed-app-invoke`, is a FAIL. A capability whose `windows` is `["*"]` is a FAIL even if it grants nothing. The generated `permissions/autogenerated/` tree is a BUILD artifact — state the `cargo check` precondition and read it only as corroboration (G-425). Cross-run `.opencode/tests/settings-credits/regression.md` R-5 (the same property asserted from the settings feature) and `resident-shell/regression.md` RT-6.

- [ ] **F-2.6 (R-2.4) [static]** — **label identity and the ONE pattern family that may match it** (INVERTED IN PLACE by #3146; superseded property, same row id, same label fact).
  - **Read the code that builds the label.** `INSTALLED_APP_WINDOW_LABEL_PREFIX` (value `"installed-"`) and `installed_app_window_label` in `apps/tauri/src-tauri/src/applications/installed_apps/window.rs`, and the built-in prefix `GENERIC_APP_WINDOW_LABEL_PREFIX = "app-"` in `infrastructure/app_window.rs`.
  - **EXPECTED (label facts, unchanged by #3146):** the installed prefix is `"installed-"`, the built-in prefix is `"app-"`, and the two are **different prefixes**, so no label can be both. `installed_app_window_label` is the **only** minting site for an `installed-` label: quote every call site of it in the product source (directory listing + grep over `apps/tauri/src-tauri/src`), and confirm the only producer is `open_installed_app_window`, reached only after `resolve_open_target` verified the install record.
  - **EXPECTED (the inverted reach assertion):** across **every** `apps/tauri/src-tauri/capabilities/*.json`, exactly **one** file's `windows`/`webviews` entries match a label beginning `installed-`, and that file is the installed-tier capability whose single pattern is `installed-*`. **No other pattern in any file can ever match a label starting `installed-`.** State this per file (filename → the pattern(s) that match `installed-` → yes/no). A second matching file, or a pattern that matches `installed-…` from the built-in capability, is a FAIL.
  - **EXPECTED (the reciprocal, newly required):** no `app-*` pattern matches an `installed-…` label, and no `installed-*` pattern matches a built-in label (`main`, `terminal`, `doom`, `app-<id>`). Prove both directions with the same matcher and quote the four resulting booleans. This is the tier separation the ACs depend on: a mis-keyed pattern would make one tier out of two while F-2.5's counts still read correctly.
  - **EDGE:** an `installed-` label that could also be produced by `app_window_label()` is a FAIL (two owners for one label namespace). A capability that names `installed-<a specific id>` instead of the `installed-*` family is a FAIL of the "one capability for the whole installed tier, no per-application capability file" constraint (see `regression.md` R-8.3).

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
  - **EXPECTED:** AC-5 verbatim — *"no code from any installed application runs"*. Before: (a) and (b) are zero, and no `installed-*` document exists to carry a mount stamp (proven by the zero window count — never by a child read, which cannot run when there is no child). After the first open: an `installed-<id>` window exists, ≥1 serve line for that id appears, and the document line reads `ready=true` with a non-empty `mount=` (a native read of that window). That pair is the discriminator: the marker can only exist after a first open, and the serve line is read from the HOST, not from the child it would deny. If neither serve instrument yields a line at all, that is an **ARTIFACT defect to report** — never a PASS and never a downgrade of the row.
  - **EDGE:** a screenshot offered as proof of absence is not evidence (G-408) — the row is the zero-count + the positive marker only. A boot that pre-creates the window is a FAIL. An IPC capture is neither required nor admissible as the proof: `logic-verified — invoke not observable through the monitor in this build` (G-3098).

- [ ] **F-5.2 (R-5.2) [live]** — open the **hang-on-load app** (a stable ~10 s observation window) and take **native captures** of that window across the window (at least one mid-load and one at the panel), corroborated by the valid app (a fast load still shows the panel in at least one capture). **A 50 ms DOM poll is not available** — the child is unreachable by `tauri_webview_*`; read the panels from the captures.
  - **EXPECTED:** AC-5 verbatim — *"they see a loading state until it is usable"*: `installed-app-loading` is visible BEFORE the app is usable, is `role="status"` `aria-live="polite"` with accessible name **"Loading <displayName>"** (read the name from the child's own a11y tree), and disappears (valid app) or is replaced by the failure panel (hang) — never both at once.
  - **EDGE:** a loading panel that never disappears on a healthy app is a FAIL; a frozen host (no repaint) during the load is a FAIL of the performance axis (N-3).

- [ ] **F-5.3 (R-5.3) [live]** — open the lazy-trace app, record its `data-mounted-at`, then close the window (host `installed_app_close` or the window control).
  - **EXPECTED:** AC-5 verbatim — *"the application stops running"*: `tauri_manage_window list` no longer lists `installed-<id>`; a native enumeration of the desktop no longer finds the child window, and the recorded mount stamp **cannot be read afterwards** (the browsing context that carried `data-mounted-at` is gone). State explicitly that the discriminator is the destroyed browsing context. **Do NOT cite an `execute_js` timeout as that proof** — `execute_js` times out against a healthy installed window too (#3147), so the timeout is indistinguishable from the feature working; the window list plus the native enumeration are the instruments.
  - **EDGE:** a closed window whose label lingers in the list is a FAIL; a "close" that only hides the window (still executable) is a FAIL.

- [ ] **F-5.4 (R-5.4) [live]** — re-open the same app after the close, without restarting the host.
  - **EXPECTED:** AC-5 verbatim — *"opening it again works without restarting Fredo"*: the window reappears, the document line carries a **NEW** `mount=` (a fresh document, not a reused context), the host process PID is unchanged, and the host log shows a new serve line (per the **Serve-line receipt** above).
  - **EDGE:** re-open → close → re-open three times: each `mount=` differs; no `Maximum update depth exceeded`; no duplicate `installed-<id>` window.

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

## AC-6 — declared reach, undeclared refusal, data ownership, consent, identity (#3146)

> **This group is the P0 security boundary: "an installed application reaches only the backend
> surface it declared."** Every row here is `[NEW]` (it must redden on the pre-#3146 tree) unless it
> is tagged otherwise.
>
> **The ONE call route.** The installed tier's only app command is `installed_app_invoke`, and the
> only child-facing door is the host-authored shim `window.__FREDO_INSTALLED__.invoke(action, args)`
> (added to `applications/installed_apps/bootstrap.js` by ST-3). **A row that calls a raw command
> name is testing the ACL, not the feature** — F-7.10 is the single deliberate exception and says so
> in its own text.
>
> **The PRE-CHANGE REDDEN CONTROL, stated once and relied on by every `[NEW]` row below.** On the
> pre-#3146 tree there is no `window.__FREDO_INSTALLED__.invoke` and no `installed_app_invoke` in
> `COMMAND_MANIFEST`, so the fixture rejects each probe step with the code **`no-invoke-shim`** and
> every rendered line reads `FAIL <id> codes=no-invoke-shim,…` instead of the `PASS` the row names.
> The control is the committed diff: `git diff origin/main...HEAD -- apps/tauri/src-tauri/
> src/applications/installed_apps/{authority.rs,dispatch.rs,scope.rs,commands_consent.rs}` must be
> non-empty for the row to be meaningfully green. A row that is green with that diff reverted is a
> suite defect, not a PASS.
>
> **Fixtures.** `node .opencode/tests/installable-apps/fixtures/build-capability-fixtures.mjs`
> (QA-authored WITH this suite — see **Required test data**). Read ids / files / expected install
> refusals / per-fixture `probeIds` from the `CAPABILITY-FIXTURES.json` the generator writes into its
> output directory; never from memory. The generator commits **no** hash manifest, so nothing can go
> stale: it self-checks every archive (re-parse, CRC, manifest + `capabilities` round-trip, mount
> export, the exact capability defect for a refusal fixture, every advertised probe id embedded in
> `main.js`, the rendered-mirror hooks, and the negative control's knowingly-false probe) and exits
> non-zero on any problem. Determinism is proven by running it **twice** and comparing the printed
> `sha256` column — quote both runs.
>
> **Read pattern (uniform) — the fixtures drive THEMSELVES; you only READ.** Do **not** inject anything
> into the child: every `tauri_webview_*` call against `installed-<id>` returns
> `Request timeout after 2000ms` (see **Child evidence transport**). Instead:
> 1. install the package, open it (`installed_app_open`), wait for the document line
>    `QA3146-DOCUMENT … ready=true mount=<id>` to appear (a fresh window can take a few seconds), and
>    confirm `[data-qa3146-header]` names the app you meant to read;
> 2. **read `[data-qa3146-assertions]`** with a native UIA text read (corroborated by a native capture)
>    and quote the line whose id is the row (e.g. `PASS F-7.13 codes=scope_denied,scope_denied,scope_denied,ok`);
> 3. for anything the line abbreviates (a `detail` string, an exact row value), read
>    `[data-refusal-json]` / `[data-call-log]` from the same capture;
> 4. **read once per document and state the `mount=` you read it at.** A re-open produces a NEW document
>    with a new `mount=` and a fresh set of lines — never mix lines from two documents into one
>    observation, and never treat a stale capture as the current state.
>
> **THE REFUSAL `detail` — read it for EVERY refusing call (binding on every row below that observes a
> refusal: F-7.5/7.6/7.7/7.11/7.12/7.13/7.17/7.20/7.22/7.24/7.26/7.28/7.31/7.36).** A `codes=` clause
> carries the refusal **code** only, so several different causes read identically there. The `detail`
> is what separates an authority refusal from a handler-body failure and from a leak, so:
> 1. in the **same capture** read `[data-call-log]` — a `<pre>` whose text is
>    `JSON.stringify(records, null, 2)`, one entry per call in drive order, each
>    `{ "action": …, "raw": <bool>, "ok": <bool>, "value": <any>|null, "refusal": <object>|null }`;
> 2. select the entry by **`action` AND `ok:false`** — never "the first `ok:false`" when the row drove
>    more than one refusing call, and **never** `[data-refusal-json]` unless the call the row names is
>    the LAST refusal the document made (that node carries only the last one; it is a `<pre>` with the
>    same object verbatim);
> 3. quote `refusal.code`, `refusal.appId`, `refusal.action` and **`refusal.detail` verbatim**, and
>    state the `mount=` of the document they came from. A detail that is not visible as text in the
>    capture is a FAIL of AC-2's displayable-refusal clause.
>
> **What each cause must say — fixed text, quote the constants beside the reading**
> (`authority.rs:288-302`, `scope.rs:43-52`, `dispatch.rs:420-457`):
>
> | Cause | `code` | Expected `detail` (verbatim) |
> |---|---|---|
> | the package declared no such capability | `action_not_declared` | `This application's package did not declare the capability this action needs.` |
> | the action is outside the dispatchable vocabulary | `action_not_grantable` | `This action is not one an installed application may invoke, so Fredo refused it.` |
> | a high-risk capability is declared but not consented | `consent_required` | `You have not allowed this capability for this application yet. Allow it in Settings > Installed applications, then try again.` |
> | **any** scope cause: a foreign `applicationId`, a table the caller did not declare, a composed/constructed canonical-name collision, a persisted declaration owned by another application, or a canonical (`source:"canonical"`) ref | `scope_denied` | `This application can only reach the data tables it declared for itself.` — the SAME sentence, byte-identical, for **all** of them |
> | the window label did not classify to an installed app | `caller_unknown` | `Fredo could not establish which application made this call, so it refused it.` |
> | the install record is gone | `app_not_installed` | `This application has no install record any more, so Fredo refused the call.` |
> | a handler **body** failed AFTER every authority gate passed (the vocabulary is closed at six, so the body's own message rides under `scope_denied`) | `scope_denied` | the body's own message — e.g. `record ["n1"] does not exist in application 'qa3146-app-a' table 'notes'` (the pre-W-3 shape) or `application_data_write for application '…' table '…' carries an empty set`. **Quote it and FAIL the leg the row says must succeed** — on a green build no `application_data_*` leg carries this shape |
> | the request could not be read as the action's arguments | `scope_denied` | `the request could not be read as a <action> call: <serde detail>` — a FAIL of any row that drove a well-formed request |
>
> **The scope causes are deliberately INDISTINGUISHABLE — do not require distinct wording per cause.**
> `SCOPE_DENIED_DETAIL` is one sentence for every scope cause and F-7.31 *requires* that ("that table
> exists and is someone else's" and "that table does not exist" must read the same, or the refusal is an
> installed-application enumeration oracle). So the **cause is established by the call the row drove**
> (`action` + `ref` in that same log entry) while the **`detail` is asserted as the byte-identical
> sentence**, including across causes: a row that demanded different wording per scope cause, or that
> accepted a detail naming another application, another application's table, the composed physical name
> (`feature_<id>_<table>`), `mission-monitor`, or a count of installed apps, is wrong in both
> directions. `appId` echoing the caller's OWN id is explicitly allowed.
> **FAIL conditions for this clause:** a missing or empty `detail`; a `detail` that is a bare code; a
> `scope_denied` on a SCOPE leg whose detail is not the fixed sentence; a body-failure detail on a leg
> that must succeed; any forbidden string above; and a `refusal.appId` that echoes the requested id
> instead of the derived one.
>
> **POSITIVE CONTROL P-1 — the app's OWN declared table, driven from the HOST, held in the same round
> (binding on every D-A row: F-7.5, F-7.6, F-7.7, F-7.11, F-7.12, F-7.13, F-7.22, F-7.24, F-7.26,
> F-7.36).** The child mirror proves what the *installed* tier did; it cannot prove the shared handler
> body works, and a run where everything refuses would otherwise satisfy every negative clause. Each of
> those rows therefore requires this five-reading sequence from `main` against `qa3146-app-a`'s declared
> `notes` table (primary key `id`, column `body`), every reading quoted:
> 1. **declare** — `application_data_declare {declarations:[{applicationId:"qa3146-app-a",
>    declarationRevision:"qa3146-probe-r1", tables:[<the `notes` table object copied from
>    CAPABILITY-FIXTURES.json>]}]}` ⇒ resolves (same content as the fixture's own declare; a capability
>    refusal here is a FAIL of P-1);
> 2. **`0`** — `application_data_delete {ref:{applicationId:"qa3146-app-a",table:"notes"}, key:["pc1"]}`
>    (any outcome), then `application_data_read {ref:…, where:[{field:"id",eq:"pc1"}], limit:10}` ⇒
>    `rows.length === 0`, quoting the whole `{version, rows, retention}` result;
> 3. **insert ⇒ `1`** — `application_data_write {ref:…, key:["pc1"], set:{body:"pc-insert"}}` ⇒
>    **resolves** (record its `updated`; P-1 does not adjudicate that number — F-7.36 owns it), then the
>    same read ⇒ **exactly one row** with `body === "pc-insert"`;
> 4. **update** — `application_data_write {…, key:["pc1"], set:{body:"pc-updated"}}` ⇒ resolves, and the
>    next read shows `body === "pc-updated"` on **one** row (an insert path that degrades the update
>    path is a FAIL of P-1);
> 5. **cleanup** — `application_data_delete {ref:…, key:["pc1"]}`, then the same read ⇒
>    `rows.length === 0`, leaving the table as P-1 found it so F-7.5 stays re-runnable.
> **P-1 writes ONLY into `qa3146-app-a`'s `notes`.** Never run a P-1-style write against
> `qa3146-app-b`'s `records` while B's document is open: B's live watch (F-7.13) announces any change
> in that table and would redden on the control's own write, masking a landed write. B's own-table
> control is a **read** (see F-7.11).
> **Why this is the control and not decoration:** steps 2→3 are the host-observed `0 → 1` of the
> declared-table insert path (W-3). On the pre-W-3 body step 3 is **REJECTED** with
> `record ["pc1"] does not exist in application 'qa3146-app-a' table 'notes'` — quote it and report P-1
> as NOT held; never answer a D-A row from the child's mirror alone. **Record P-1 once per round** (with
> the readings and when they were taken) and cite that one record from each listed row — but a row whose
> round has no held P-1 is **UNVERIFIED, never PASS**. P-1 is a control, not a row: it is not graded as
> an AC, and it never substitutes for the row's own audited leg.
>
> **A row PASSES only when its line is `PASS <row id>` AND its `codes=` clause is exactly the one the
> row states.** `codes=` is positional (`ok` = resolved). A visible `FAIL`, a missing line, or a
> `codes=` clause that differs from the row's is a FAIL of that row. A row whose evidence is
> **host-driven** (F-7.36 and P-1, and the `(b)` half of F-7.11/F-7.13's controls) has no child line by
> design: it quotes the `main` command calls and their results and says so explicitly. For every row in
> this group also record the `qa3146-mirror-control` line in the same round (see **Child evidence
> transport**).

- [ ] **F-7.1 (R-3.2 / R-3.1 / R-3.4) [unit][NEW] — the ownership resolver is a PURE function and its decisive case is the composed name.** Instrument: `cargo test --lib --locked resolve_data_scope` from `apps/tauri/src-tauri` (disclose a `cargo test` substitution for `nextest`, G-282). The function is `resolve_data_scope(caller_app_id, requested_app_id, table, declared_tables, known_app_ids, owned_tables) -> ScopeDecision::{Allow, Deny(&'static str)}` — **no database**, so this row never opens a window.
  - **EXPECTED — quote every case's inputs and verdict, table-driven:**
    (1) caller `qa3146-app-a`, requested `qa3146-app-a`, table `notes`, declared `[notes]`, known `[qa3146-app-a]`, owned `[]` ⇒ **Allow** (the positive control: an over-broad deny fails here).
    (2) requested `qa3146-app-b` ⇒ **Deny**.
    (3) table `secrets` with declared `[notes]` ⇒ **Deny** (declared-set clause).
    (4) **THE NAMED COLLISION:** caller `mission`, requested `mission`, table `monitor_sessions`, declared `[monitor_sessions]`, known `[mission, mission-monitor, …RESERVED_APP_IDS]`, owned `[]` ⇒ **Deny**. Record the composed name the case asserts (`feature_mission_monitor_sessions`) and state in the receipt that the caller **never names `mission-monitor`**.
    (5) **THE CONSTRUCTED COLLISION (installed vs installed):** caller `orbit`, requested `orbit`, table `lab_notes`, declared `[lab_notes, orbit_own]`, known `[orbit, orbit-lab]` ⇒ **Deny**.
    (6) **THE DISCRIMINATOR:** same caller, same `known`, table `orbit_own` ⇒ **Allow**. (5)+(6) together are the proof: identity-equality alone passes (5) and passes (6), so (6) alone cannot distinguish a correct implementation from a permissive one, and (5) alone cannot distinguish it from one that denies everything.
    (7) `owned_tables` cross-owner composition: caller `orbit`, table `lab_notes`, `known=[orbit]`, owned `[(orbit-lab, notes)]` ⇒ **Deny** (the `feature_data_tables` ownership clause alone, with the id list NOT naming the other app).
    (8) order-independence: the SAME case (5) with every slice reversed ⇒ the SAME verdict (the resolver treats its inputs as sets — the *install order* leg is live and belongs to F-7.11/F-7.12).
  - **EDGE:** a resolver that returns `Allow` for (4), (5) or (7) is a total FAIL of AC-3 (the many-to-one composition is the one defect that would ship silently). A resolver that `Deny`s (1) or (6) is a FAIL of AC-1. A case that needs a database is not this row — do not migrate it to a live row.

- [ ] **F-7.2 (R-2.1 / R-2.2 / R-2.3) [unit][NEW] — the tier classifier and the refusal wire shape.** `cargo test --lib` on the `authority` module.
  - **EXPECTED (classifier, fail-closed):** `main` / `terminal` / `doom` / `app-<anything>` ⇒ `CallerTier::BuiltIn`; `installed-qa3146-app-a` ⇒ `Installed` with `app_id = Some("qa3146-app-a")`; and **every** other label ⇒ `Err(caller_unknown)` — enumerate at least: `""`, `installed-` (empty id), `installed-QA3146` (upper case), `installed-qa_3146` (underscore), `installed-mission-monitor` (a RESERVED id), `installed-qa3146-app-a-evil` is **valid** (quote the actual verdict rather than assuming), `webview-1`, `installed-..`.
  - **EXPECTED (serialized refusal — G-413, assert the WIRE not the type):** serialize a `CapabilityRefusal` with `capability: Some("high-risk.database-query")` and compare the JSON **key list** to exactly `action, appId, capability, code, detail` (5 keys, sorted). Serialize one with `capability: None` and assert the key list is exactly `action, appId, code, detail` — **the `capability` key is ABSENT**, never `null` and never `""`. Assert the six `code` values serialize as the exact snake_case strings `action_not_declared`, `action_not_grantable`, `consent_required`, `scope_denied`, `caller_unknown`, `app_not_installed` — quote the enum's serde attribute as shipped.
  - **EDGE:** a refusal serialized with `capability: null` passes a type-level check and crashes a consumer that distinguishes presence — this is why the row asserts the serialized payload. A seventh code, or a PascalCase wire value, is a FAIL (the authority vocabulary is a SEPARATE six; the installer's 22 stay frozen — `regression.md` R-8.2).

- [ ] **F-7.3 (R-1.2 / R-2.1 / R-2.2) [unit][NEW] — the dispatch table is an ordered exact set, and nothing dangerous is in it.** `cargo test --lib` on the `dispatch` module.
  - **EXPECTED:** the action→capability table is asserted as an **ORDERED sequence** (G-494 — a membership check passes a same-set reorder); every dispatchable action is a real entry in `COMMAND_MANIFEST` (`src/runtime/command_manifest.rs`) — quote any action that is not; and the table contains **none** of: `installed_app_*`, `application_store_*`, `subscribe_events`, `application_data_watch`, `application_data_unwatch`, `open_app_window`, `close_app_window`, `installed_app_consent_grant`, `installed_app_consent_revoke`. Capability ids are exactly the closed four `data.tables`, `high-risk.database-query`, `high-risk.database-reset`, `high-risk.process-spawn` — asserted as an ordered exact set too.
  - **EDGE:** a reorder that keeps the set identical must redden (that is the whole point of the ordered form). An action in the table that is absent from `COMMAND_MANIFEST` means the dispatcher forwards a command nothing grants — a FAIL.

- [ ] **F-7.4 (R-2.4 / NFR least-privilege) [static][NEW] — the installed tier's command surface is exactly one command, granting one permission, with no `core:*`.** Read `apps/tauri/src-tauri/capabilities/installed-app-commands.json`, `permissions/app/default.toml`, `src/runtime/command_manifest.rs` and `src/lib.rs`.
  - **EXPECTED:** (a) the capability's `identifier` is `installed-app-commands`, `windows` is exactly `["installed-*"]`, `permissions` is exactly `["allow-installed-app-invoke"]` — quote the whole file; (b) **no `core:*` entry** anywhere in it; (c) `installed_app_invoke` appears in `COMMAND_MANIFEST`, in `generate_handler![]` and as `allow-installed-app-invoke` in `permissions/app/default.toml` (the existing guard `every_registered_command_is_granted_to_the_built_in_windows` requires the built-in grant — quote it green, because that guard's requirement is WHY the permission must also be granted to the built-in set); (d) the five #3147 installed-app commands plus the two #3146 consent commands are still present in the manifest, and **`installed_app_invoke` is the only NEW registered command** (F-7.5's sibling guard).
  - **EDGE:** a second permission in the installed capability is a FAIL of least privilege even if harmless. `permissions/app/default.toml` is a permission SET (no `windows` key) — its presence is expected and widens no window. F-2.5 owns the directory-wide matcher; this row owns the command/permission surface.

- [ ] **F-7.5 (R-1.1 / R-1.2 / R-1.3) [live][NEW] — AC-1: every declared action succeeds, and "everything refused" cannot pass.** Fixture `qa3146-app-a` (declares `data.tables{notes, shared_log}`), installed and open.
  - **READ** `[data-assertion="F-7.5"]`. The fixture itself drives, in order: a pre-clean delete of `n1`+`n2` (so a re-open re-runs the same assertions), `application_data_write` `{ref:{source:"application",applicationId:"qa3146-app-a",table:"notes"},key:["n1"],set:{body:"hello-a"}}` → `application_data_read` `{…same…}` → `application_data_delete` `{key:["n1"]}` → `application_data_read` → `application_data_declare` `{declarations:[{applicationId:"qa3146-app-a",declarationRevision:"qa3146-probe-r1",tables:[<the notes table copied from CAPABILITY-FIXTURES.json>]}]}`.
  - **EXPECTED:** the line reads `PASS F-7.5` with `codes=<c1>,<c2>,ok,ok,ok,ok,ok` — the two pre-clean deletes may carry any code, and the **five assertions all `ok`** — plus `rowsAfterWrite=1`, `rowsAfterDelete=0`. **No `ok` position may instead be a capability code** (`action_not_declared`, `action_not_grantable`, `consent_required`, `scope_denied`, `caller_unknown`); if one is, quote it and FAIL. The declare resolves **or** refuses only with a declaration-content validation error (quote it from that call's `[data-call-log]` entry) — never a capability refusal (the registry is idempotent, so a same-content re-declare must not be refused for being declared by an installed app).
  - **NON-VACUITY CONTROL = P-1 (mandatory, same round, from `main`):** hold the AC-6 preamble's P-1
    recipe against `qa3146-app-a`'s `notes` table and quote its five readings — `rows.length === 0`
    before, the write resolving, **exactly one row with `body === "pc-insert"` after** (the host-observed
    `0 → 1`), the same key updated to `pc-updated`, and the cleanup back to `0`. That is what proves the
    command, the table, the ordinary handler body **and the insert path** are live — so A's success is a
    real success and A's *other* refusals (F-7.8) are real refusals. A round with no held P-1 leaves this
    row UNVERIFIED.
  - **DETAIL (mandatory if any step is refused):** read the refusing call's own `[data-call-log]` entry
    and quote `refusal.code` + `refusal.detail`. The write step (call 3 in the fixture's sequence,
    `application_data_write … key:["n1"]`) must be `ok:true`; if it is refused, quote the detail — a
    `scope_denied` carrying `record ["n1"] does not exist in application 'qa3146-app-a' table 'notes'`
    is a FAIL of the declared-table insert path (W-3), never a scope refusal. Any refusal on any step
    must match the AC-6 cause table verbatim (see the preamble).
  - **REDDEN CONTROL:** on the pre-change tree — the #3146 authority diff absent (`authority.rs` /
    `dispatch.rs` / `scope.rs` / `commands_consent.rs` unmodified) — the log reads `no-invoke-shim`; on
    a tree with the authority diff but without W-3, the write step is refused with the
    `record […] does not exist` detail above and `rowsAfterWrite` reads `0`. Both are the row's
    failability; quote which tree you are on.
  - **EDGE:** do **not** bind a literal `updated` value here — the AC does not state one; record what you
    saw (F-7.36 owns the insert's `updated` contract). A write that resolves while the host read shows
    **no** row is a FAIL of the handler body/insert path, not of this row's shape. A `rowsAfterWrite=1`
    read from the child alone, with no P-1, is not non-vacuity.

- [ ] **F-7.6 (R-1.3 / NFR no-caller-supplied-identity) [live][NEW] — the app supplies no identity and the host derives it.** Fixture `qa3146-app-a`, open.
  - **READ** `[data-assertion="F-7.6"]`. The fixture writes `{ref:{applicationId:"qa3146-app-a",table:"notes"},key:["n2"],set:{body:"no-identity"}}` (so a row exists that ONLY A wrote), then runs a read whose `ref` **omits `applicationId` entirely**: `{action:"application_data_read", args:{ref:{source:"application",table:"notes"},where:[],limit:10}}`, then deletes `n2` so the table is left as it found it.
  - **EXPECTED:** `PASS F-7.6 codes=ok,ok,<any>` (the trailing cleanup delete) — the read resolved and returned the `n2` row with `body === "no-identity"` (the fixture's `derivedId` check asserts exactly that); the id was injected from the window label `installed-qa3146-app-a`. Quote the `codes=` you read.
  - **THE INSERT LEG IS INSIDE THIS ROW:** `n2` is a key that does not exist yet, so step 1 is a declared-table **insert**. Read its `[data-call-log]` entry and quote it: `ok:true` with `.value` (record `updated`), and **no** refusal. A `scope_denied` there whose `detail` is `record ["n2"] does not exist in application 'qa3146-app-a' table 'notes'` is a FAIL of the insert path (W-3) — quote it; do not read that as "the identity NFR failed". Any other refusal on any step must match the AC-6 cause table verbatim (`refusal.code` + `refusal.detail` quoted from that call's entry).
  - **D-A POSITIVE CONTROL (P-1, mandatory):** cite the AC-6 preamble's P-1 record held in this round (`0 → 1` on A's own `notes` table, driven from `main`). A round in which only the negative legs ran leaves this row UNVERIFIED.
  - **EDGE:** a resolve that returns the row of a DIFFERENT app is a total FAIL. A rejection here is a FAIL of R-1.3's "without the application supplying any identity value" — record the refusal code **and detail** verbatim; do not re-drive with the id supplied and call it a pass.

- [ ] **F-7.7 (R-1.4, restart-free half) [live][NEW] — close → re-open → the same declared actions are still accepted.** Fixture `qa3146-app-a`.
  - **STEPS:** `installed_app_close{appId:"qa3146-app-a"}` ⇒ `tauri_manage_window list` shows no `installed-qa3146-app-a`; then `installed_app_open{appId:"qa3146-app-a"}` ⇒ exactly one such window, the document line reads `ready=true` with a **NEW** `mount=` (a fresh document, not a reused context), and `[data-qa3146-assertions]` carries a fresh set of lines (read the new document's lines, not the closed one's capture).
  - **EXPECTED:** `[data-assertion="F-7.7"]` reads `PASS F-7.7 codes=ok` — the read resolves on the re-opened document (it exercises ST-1's materialize-declarations-on-open) — **and no capability refusal appears on any line of the new document**. Quote `rowsAfterReopen=<n>` (a reading, not a floor; after P-1's cleanup it should read `0` — if it does not, quote the rows it returned and report the leftover as row hygiene).
  - **DETAIL (mandatory — this row's negative clause is what needs it):** "no capability refusal appears" is only checkable against the code **and** the detail. Read every `ok:false` entry in the new document's `[data-call-log]` (there should be none) and quote the `[data-refusal-code]` / `[data-refusal-json]` nodes too: a `scope_denied` whose detail is the body-failure shape (`record […] does not exist …`, or `… carries an empty set`) is a FAIL of this row even though it is not a *capability* refusal — that is exactly the read that separates a re-materialization defect from a handler-body defect. Any refusal present must match the AC-6 cause table verbatim.
  - **D-A POSITIVE CONTROL (P-1, mandatory):** cite the AC-6 preamble's P-1 record held in this round. A re-opened document that only ever refuses, with no held P-1, leaves this row UNVERIFIED.
  - **EDGE:** a staged write that does not persist across the reopen is a FAIL of R-1.3's store semantics, not of this row — record it and cross-check via the `main` control read. The **reinstall** half of R-1.4 is INERT in this slice — see F-7.25.

- [ ] **F-7.8 (R-2.1 / R-2.3) [live][NEW] — AC-2: an undeclared action is refused cleanly, the app displays a refusal it can handle, and both keep running.** Fixture `qa3146-app-a` (declares `data.tables` only), open; record the document line's `mount=` first.
  - **READ** `[data-assertion="F-7.8"]`; the fixture drives `pg_database_reset` itself.
  - **EXPECTED:** `PASS F-7.8 codes=action_not_declared appId=qa3146-app-a` — the call was **refused** (a rejected promise: never a resolved value, never a silent no-op) with code `action_not_declared`; the same call's entry in `[data-call-log]` carries a refusal object with `code === "action_not_declared"`, `appId === "qa3146-app-a"` (**the DERIVED id**), `action === "pg_database_reset"`, and the detail **verbatim `This application's package did not declare the capability this action needs.`** — quote it as readable text (never colour-only; the AC-6 cause table is the reference). `[data-qa3146-summary]` reads `done=true`.
  - **BOTH KEEP RUNNING:** `tauri_manage_window list` still lists `installed-qa3146-app-a` **and** `main`; the host PID is unchanged; the host still answers (`get_control_setting{key:"app_window_presentation"}` from `main` returns without error); the env database is still functional (the `main` control read of F-7.5 still returns).
  - **NO FALLBACK PATH:** the log contains **one** entry for the attempt, not two — a resolved-then-refused pair, a retry against a neighbouring action, or a value synthesised from a default is a FAIL of "no fallback path".
  - **EDGE:** a refusal that says `scope_denied` or `action_not_grantable` here is a FAIL of the code taxonomy (the capability exists; this package simply did not declare it). A child whose document dies on the rejection is a FAIL of containment.

- [ ] **F-7.9 (R-2.2 / R-2.3) [live][NEW] — an action outside the dispatchable vocabulary is `action_not_grantable`, and no side effect exists.** Fixture `qa3146-app-a`, open. The fixture generates the child key itself and **prints it** on the line.
  - **READ** `[data-assertion="F-7.9"]`; the fixture drives `save_control_setting{key:"qa3146-child-<token>", value:"probe-sentinel"}`, `installed_apps_list`, and `installed_app_consent_grant{appId:"qa3146-app-a", capability:"high-risk.database-reset"}`.
  - **EXPECTED:** `PASS F-7.9 codes=action_not_grantable,action_not_grantable,action_not_grantable childKey=qa3146-child-<token>` — **all three** refused (quote each code), and each call's `[data-call-log]` `refusal.detail` must be verbatim `This action is not one an installed application may invoke, so Fredo refused it.` The dispatcher **never forwards** an `installed_app_*` command — an installed app can never consent for itself, which is why the third leg matters.
  - **NO-SIDE-EFFECT CONTROL (mandatory):** from `main`, `get_control_setting{key:"<the childKey the line printed>"}` returns `null`/`None`; and the same-round HOST control `save_control_setting{key:"qa3146-host-<uuid>", value:"ok"}` then `get_control_setting` on that key **returns the value** — so the child's `null` means refusal, not a dead probe.
  - **EDGE:** a run where any of the three resolves is a total FAIL. A control that also reads `null` makes the child's `null` vacuous (G-430) — re-drive, do not report a PASS.

- [ ] **F-7.10 (R-2.4 / NFR least-privilege) [live][NEW] — the ACL is the second lock: exactly one raw command is reachable, everything else is refused, and the child survives.** Fixture `qa3146-app-a`, open. **This is the one probe that deliberately uses the RAW handle** (`window.__TAURI_INTERNALS__.invoke`, inside the fixture) — its subject is the command surface, not the feature.
  - **READ** `[data-assertion="F-7.10"]`, then quote the four verbatim rejections from `[data-call-log]` (the fixture records each raw refusal in full).
  - **EXPECTED:** `PASS F-7.10` — steps 1–3 (`get_control_setting{key:"app_window_presentation"}`, `installed_app_consent_grant{…}`, `installed_app_install{archivePath:"C:/nonexistent.zip"}`) are **refused by the ACL**: each message names an authority/permission condition, **not** `net::ERR`, not CSP, not a timeout (the line's `s1Acl`/`s2Acl`/`s3Acl` + `s1Transport`… checks are exactly that discrimination); step 4 (`installed_app_invoke`, the one granted command) **is not ACL-refused** (it resolves, or returns the dispatcher's own result/refusal — either way the error must not be an ACL denial). `[data-qa3146-summary]` reads `done=true` (the document survived every rejection) — a catchable promise rejection, never a document teardown. **A raw-handle rejection is a long free-text message, so the positional clause abbreviates it to `refused`** (`codes=refused,refused,refused,ok`) — judge the clause from the verbatim messages, not from that token.
  - **EXPECTED (corroboration from the static guard):** quote F-7.4's `permissions: ["allow-installed-app-invoke"]` beside this row — the live surface and the static declaration must describe the same one command.
  - **EDGE:** if entry 1 resolves, the installed document has the built-in command surface and every other row is meaningless — record it as a total FAIL of AC-2 and of the tier boundary. If the rejection is a transport/CSP failure instead of an ACL failure, F-2.2's EDGE applies (the child's `connect-src` keeps `ipc:` reachable on purpose). Cross-reference F-2.2, which covers the same class with raw commands from the #3147 probe app.

- [ ] **F-7.11 (R-3.2) [live][NEW] — AC-3 decisive, LIVE, install order A-FIRST: the composed name is refused and the caller never names the other app.** Fixtures, in this order: `mission` installed first, then `qa3146-app-b`.
  - **STEPS:** install `mission` (`installed_app_install{archivePath:"<out>/mission-1.0.0.zip"}`), install `qa3146-app-b`; open **B first** (its probe seeds `records{id:"r1"}` = `value:"b-original"` and its F-7.13 watch starts), then open `mission`.
  - **READ (on `installed-mission`)** `[data-assertion="F-7.11"]`; the fixture drives `application_data_read` of `{applicationId:"mission",table:"monitor_sessions"}` and, second, of a table `mission` did not declare.
  - **EXPECTED:** `PASS F-7.11 codes=scope_denied,scope_denied appId=mission` — refused with `scope_denied`, `appId === "mission"` and **no rows came back at all** (a rejected promise is the structural form of "receives no data"). Read the FIRST call's `[data-call-log]` entry and quote its `detail`: the refusal must name the AMBIGUITY/ownership rule, not "no such table" (a `detail` that only says the table does not exist is a FAIL — quote it either way). Nothing changed (corroborate: the row count of `feature_mission_monitor_sessions` — read from `main` via the Database Client or `db_query_execute` if a connection is configured — is identical before and after; **non-gating corroboration**, and if it cannot be read, say so rather than substituting).
  - **SAME-RUN POSITIVE CONTROL (mandatory, two halves):** (a) read `[data-assertion="F-7.11"]` on
    `installed-qa3146-app-b` ⇒ `PASS F-7.11 codes=ok,ok` (its own declared `records` resolves with
    `value === "b-original"`); (b) from `main`, `application_data_read` on
    `{ref:{applicationId:"qa3146-app-b",table:"records"}, where:[], limit:10}` ⇒ exactly one row with
    `value === "b-original"` — quote `rows.length` and the value. So B's own declared table works in
    **both** tiers while mission's composed reach is denied: "everything denied" cannot pass this row.
    **Cite the AC-6 preamble's P-1 record too** (declare → write → read → update on A's own table), and
    **never** write into B's `records` while B's watch is live — that would redden F-7.13's watch line
    and mask a landed write. A round with neither (b) nor a held P-1 leaves this row UNVERIFIED.
  - **DETAIL (mandatory, both refusing calls, read by cause):** read the `[data-call-log]` entry of call
    1 (`application_data_read` of `mission` + `monitor_sessions`) and of call 2 (a table `mission` did
    **not** declare) and quote each one's `refusal.code`, `refusal.appId` and `refusal.detail`, plus the
    `mount=`. **Expected `detail` for BOTH: `This application can only reach the data tables it declared
    for itself.` — the same sentence, byte-identical** (the cause is identified by the call the row
    drove, not by the wording: the scope causes are deliberately indistinguishable, `scope.rs:43-52` +
    F-7.31). A detail naming the table's absence ("does not exist"), any application id
    (`qa3146-app-b`, `mission-monitor`), any table name (`records`, `monitor_sessions`), the composed
    physical name (`feature_mission_monitor_sessions`), or an installed count is a FAIL — quote it. The
    two details differing at all also fails the non-oracular clause; report it under F-7.31 as well.
  - **NON-GATING CORROBORATION that the collision target is REAL:** record whether `feature_mission_monitor_sessions` exists in the env database. The deny does not depend on it (the reserved ids are in the known-id set unconditionally) — this is a reading, not a precondition.
  - **EDGE:** a `scope_denied` that arrives only because the table does not exist is not the proof — the refusal detail must name the AMBIGUITY/ownership rule, not "no such table" (quote it). A `mission` read of a table it did **not** declare must also be `scope_denied`, never `action_not_declared` (the capability is declared; the table is not).

- [ ] **F-7.12 (R-3.2 / R-3.4) [live][NEW] — AC-3, the CONSTRUCTED installed-vs-installed collision, install order B-FIRST, with the same-app discriminator.** Fixtures, in this order: `orbit-lab` installed first, then `orbit`.
  - **STEPS:** install `orbit-lab`, then `orbit`; open `orbit`.
  - **READ (on `installed-orbit`)** `[data-assertion="F-7.12"]`; the fixture drives, in ONE document: `application_data_write` of `{applicationId:"orbit",table:"orbit_own"},key:["o1"],set:{body:"orbit-own-value"}`, then reads `lab_notes`, then reads `orbit_own`.
  - **EXPECTED:** `PASS F-7.12 codes=ok,scope_denied,ok` — (1) `lab_notes` ⇒ `scope_denied` (the write and the second read must be `ok`): `orbit` + `lab_notes` composes to `feature_orbit_lab_notes`, byte-identical to `orbit-lab` + `notes`, and **`orbit` never names `orbit-lab`**; (2) `orbit_own` ⇒ **resolves** with `body === "orbit-own-value"` in the SAME document. Then on `installed-orbit-lab`: `[data-assertion="F-7.12"]` reads `PASS F-7.12 codes=scope_denied` (its `notes` read is refused).
  - **RECORDED CONSEQUENCE (state it, do not FAIL it):** an installed id whose sanitized form extends another known id's (`orbit-lab` vs `orbit`) is shadowed on **every** table. That is the documented fail-safe direction — the Architect's rule is that a stale/expensive id index may only ever produce a **false refusal**, never a false permit. Record the observation and the reasoning; it is a product-behaviour note for the PO, not a row failure.
  - **DETAIL (mandatory, the refusing call only):** read the `[data-call-log]` entry for the `lab_notes` read and quote `refusal.code`, `refusal.appId` (`orbit` — the derived id) and `refusal.detail`. **Expected: `This application can only reach the data tables it declared for itself.`** A detail containing `orbit-lab`, `notes`, `feature_orbit_lab_notes` or any count is a FAIL (it would confirm WHICH id collided — F-7.31's sharpest clause). Note the cause is identified by the driven ref, not the wording, so `orbit_own` (allowed) and `lab_notes` (denied) are still distinguishable from one capture.
  - **CROSS-TIER POSITIVE CONTROL (mandatory, from `main`, same round — it must be the FULL
    declare → write → read → update cycle on `orbit`'s OWN table):** after reading the child's line
    (which must show `body === "orbit-own-value"`), (a) `application_data_read` on
    `{ref:{applicationId:"orbit", table:"orbit_own"}, where:[], limit:10}` ⇒ **exactly one row** with
    `body === "orbit-own-value"` — the row the child wrote in that same document, read by tier 1, which
    is what proves the child's write actually **inserted** (`o1` is a new key) instead of resolving
    without a row; (b) `application_data_write {ref:…, key:["o1"], set:{body:"orbit-own-updated"}}` ⇒
    resolves, and the next read shows `body === "orbit-own-updated"` on that same one row; (c) restore
    it (`set:{body:"orbit-own-value"}`) and read it back, quoting all three readings. On a tree without
    W-3 the child's write is refused with `record ["o1"] does not exist in application 'orbit' table
    'orbit_own'`, so codes position 1 reads `scope_denied` instead of `ok` and (a) reads `0` rows.
    **Cite the AC-6 preamble's P-1 record too.** A round with neither leaves this row UNVERIFIED.
  - **EDGE:** (1) and (2) must be produced in **one** `run` — two separate drives let a stale cache pass. An implementation that denies both fails (2); one that allows both fails (1).

- [ ] **F-7.13 (R-3.1) [live][NEW] — AC-3: another application's data is unreachable BY NAME, and nothing of B's changes.** Fixtures `qa3146-app-a` and `qa3146-app-b`, both installed and open, B's `records{id:"r1"}` holding `value:"b-original"` (F-7.11's precondition — open B first).
  - **READ (on `installed-qa3146-app-a`)** `[data-assertion="F-7.13"]`; the fixture drives read / write / delete against `{applicationId:"qa3146-app-b",table:"records"}` and then a read of A's own `notes`.
  - **EXPECTED:** `PASS F-7.13 codes=scope_denied,scope_denied,scope_denied,ok` with `readAppId=qa3146-app-a writeAppId=qa3146-app-a deleteAppId=qa3146-app-a` — the first **three** are refused `scope_denied` with the DERIVED id (never the requested one); the **fourth resolves** (A's own declared table keeps working in the same document, which is the AC's third clause).
  - **DETAIL (mandatory, all three refusing calls):** read each of the three `ok:false` entries in
    `[data-call-log]` (select by `action` — read / write / delete — never by position) and quote
    `refusal.code`, `refusal.appId` and `refusal.detail`. **Expected `detail` for all three:
    `This application can only reach the data tables it declared for itself.` — byte-identical**, even
    though the three causes are nominally different (a foreign id on a read, a write and a delete). The
    cause is identified by the driven `action` + `ref`; the wording must NOT differ (F-7.31's
    non-oracular clause). A detail containing `qa3146-app-b`, `records`, `mission-monitor` or a
    `feature_…` physical name is a FAIL — quote it.
  - **HOST CROSS-CHECK + P-1 (mandatory):** (a) from `main`, the SAME own-table read
    (`{ref:{applicationId:"qa3146-app-a", table:"notes"}, where:[], limit:10}`) **resolves** with the
    ordinary `{version, rows, retention}` shape — rows may legitimately be empty here, so the
    discriminator is the result SHAPE and the absence of a refusal, never a count; (b) cite the AC-6
    preamble's P-1 record held in this round, so the own-table leg is proven by a write that landed, not
    by two empty readings. A round with no held P-1 leaves this row UNVERIFIED.
  - **B's SIDE (the "nothing changed" leg):** B's own `[data-assertion="F-7.13"]` lines read `PASS F-7.13 codes=ok unchanged` **and** `PASS F-7.13 watch value=b-original rows-observed`. The second line is B's **live watch**: it re-reads `records` every 2 s in the still-open document and announces any change, so a write that landed shows as `FAIL F-7.13 watch state=changed:pwned …`. **Do not re-open B to read it** — a re-open re-seeds `r1` and would mask a landed write; read the watch line from the document that was open when A attempted the write. **Do not write into B's `records` yourself** (no P-1-style control on B while this watch is live).
  - **EDGE:** a read that resolves with an EMPTY row set instead of refusing is a FAIL — the AC says "receives no data", and a silent empty result is the shape a confused-deputy bug takes. A delete that resolves `{deleted:false}` instead of refusing is the same FAIL. If B's row cannot be written first (B is not open/refused), the row is UNVERIFIED, not PASS.

- [ ] **F-7.14 (R-3.3, runtime half) [live][NEW] — the SECOND DOOR at runtime: a canonical table ref is refused.** Fixture `qa3146-app-a`, open.
  - **READ** `[data-assertion="F-7.14"]`; the fixture drives `application_data_read` with `ref:{source:"canonical",table:"chat"}` / `"agentSession"` / `"toolUse"`.
  - **EXPECTED:** `PASS F-7.14 codes=scope_denied,scope_denied,scope_denied` — all three refused; **no rows** (a rejected promise, not an empty array). The refusal is rendered, and each call's `refusal` is carried in `[data-call-log]` (same capture).
  - **BUILT-IN CONTROL (mandatory, same round — G-469, do not make it a count):** from `main`, the SAME three canonical reads are **not** `scope_denied` — they return the ordinary `{version, rows, retention}` shape (rows may legitimately be empty in a clean env; the discriminator is the **result shape**, not a row count, so the control cannot pass on two empty sets).
  - **EDGE:** a canonical read refused with `action_not_declared` is the wrong code (the capability is declared; the SOURCE is forbidden) — record the code, it is a FAIL. This row and F-7.15 are the two locks on one door; neither answers for the other.

- [ ] **F-7.15 (R-3.3, install half) [live][NEW] — the SECOND DOOR at install: a declared table carrying a `source` projection is refused with the exact field path.** No window is needed; drive from `main`.
  - **DRIVE:** `installed_app_install{archivePath:"<out>/qa3146-source-projection-1.0.0.zip"}`, then `installed_app_install{archivePath:"<out>/qa3146-unknown-capability-1.0.0.zip"}`.
  - **EXPECTED:** both reject with the FROZEN installer vocabulary — code `manifest_invalid_field` — and the detail **names the exact path**: `capabilities.data.tables[0].source` for the first and `capabilities.highRisk[0]` for the second (quote both details). **Nothing is installed:** `installed_apps_list` is unchanged, a directory listing of `<FREDO_DATA_DIR>/installed-apps/` shows no new `<id>/`, `tauri_manage_window list` shows no new `installed-*` window, and the settings pane shows no new entry. The 22-code vocabulary is unchanged (no 23rd code appears — `regression.md` R-8.2).
  - **REDDEN CONTROL (this row's is sharper than the group default):** on the PRE-change tree both packages are refused with `manifest_unknown_field` (the top-level `capabilities` key does not exist yet). So the row reddens on the **code**: `manifest_unknown_field` is a FAIL of this row, and it is exactly what the pre-change tree produces. Quote the code you got.
  - **EDGE:** a generic `manifest_invalid_field` with a detail that does NOT name the field path is a FAIL of the diagnosability NFR — "names the specific reason, field-scoped" is the AC's own wording. An unknown capability id silently IGNORED (install succeeds with the id dropped) is a FAIL: an ignored declaration reads to the author as accepted consent.

- [ ] **F-7.16 (R-4.1) [live][NEW] — AC-4: the specific high-risk capability is SHOWN for that application only.** Fixtures `qa3146-consent-a` (declares query + reset), `qa3146-consent-b` (declares query only) and `qa3146-no-capabilities`, all installed. Open Settings → **Installed applications** (`[data-testid="settings-nav-installed-apps"]` → `[data-testid="installed-apps-pane"]`).
  - **SURFACE SHAPE (bound to the landed UI/UX contract, §1/§2 — read it, do not assume a shape):** the consent block is a **pane-level section** placed **after the list and before the v1-limitations footer**, **not** inside an entry row (the shipped pin `InstalledAppsSettings.test.tsx` asserts an entry row has **0** buttons and must stay intact). The section is `[data-testid="installed-apps-consent-section"]`; inside it one `[data-testid="installed-apps-consent-row"]` **per APPLICATION** carrying `data-app-id`; inside a row one control line **per declared high-risk capability**, each control carrying `data-app-id` + `data-capability`.
  - **EXPECTED (Settings surface):** the section is present (≥1 app declares high-risk); A has **exactly one** `installed-apps-consent-row[data-app-id="qa3146-consent-a"]` and inside it **two** `[data-testid="installed-apps-consent-grant"]` buttons whose `data-capability` values are `high-risk.database-query` and `high-risk.database-reset`; each row line is bound to the shipped copy — the **`consequence` sentence** from `CAPABILITY_CONSENT_COPY[capability]` verbatim, the exact capability id in mono, and the chip word **`Not allowed`**; B has one row with one control (`high-risk.database-query`) and the chip `Not allowed`; `qa3146-no-capabilities` has **no row**; when *no* installed app declares a high-risk capability the whole section is **absent**, not an empty heading. Quote the button's visible text (**`Allow`**) and its accessible name (see F-7.30).
  - **EXPECTED (projection — read `installed_apps_list` from `main`, quote the JSON):** A ⇒ `capabilities: {appId:"qa3146-consent-a", declared:["high-risk.database-query","high-risk.database-reset"], highRisk:[same two], consented:[]}`; B ⇒ `declared:["high-risk.database-query"]`; `qa3146-no-capabilities` ⇒ all three arrays **empty** (but the `capabilities` object present). Arrays sorted.
  - **EXPECTED (accessibility):** each control is a real `<button>` (not a `div` with a click handler) whose accessible name contains the application name **and** the capability's verb — a bare repeated "Allow" is a FAIL (ambiguous control, and it would let a user grant the wrong app's capability).
  - **EDGE:** a blanket "Allow high-risk access" / "Trust this application" control instead of per-(app, capability) controls is a FAIL of *"that specific capability"*. A control rendered **inside** an entry row (breaking the 0-button pin) is a design FAIL — report it, do not "update" the pin. Any app declaring only `data.tables` renders no row (S0). States S6/S7/S8 are F-7.29's. Copy is F-7.30's. **A grant is never optimistic**: the chip must still read `Not allowed` until the host write settles (F-7.18).

- [ ] **F-7.17 (R-4.3) [live][NEW] — AC-4: without consent the action is refused BEFORE any side effect.** Fixture `qa3146-consent-a`, open, **no grant** (confirm `consented: []` for A in `installed_apps_list`, or the chip reading `Not allowed` in the settings consent section, BEFORE you judge the line).
  - **READ** `[data-assertion="F-7.17"]` and `[data-qa3146-consent]`; the fixture drives `db_query_execute` (connection `qa3146-no-such-connection`) and `pg_database_reset`.
  - **EXPECTED:** `PASS F-7.17 codes=consent_required,consent_required queryCapability=high-risk.database-query resetCapability=high-risk.database-reset` — both refused with `consent_required`, and the present-optional `capability` field carries the specific capability per leg (feeding F-7.28). The same calls' entries in `[data-call-log]` also carry `appId:"qa3146-consent-a"` and the attempted `action` — quote them. The refusal is readable text, never colour-only.
  - **IF POSITION 1 IS NOT `consent_required`:** check `[data-qa3146-consent] state=`. `state=granted` with a non-empty `consented` array ⇒ the row's **precondition** is not held (a grant is live): revoke it, re-open the app, and re-read — do not score a PASS or a FAIL on the wrong stage. `state=consent` (no grant) with position 1 `ok` ⇒ the consent gate did not run: **FAIL of AC-4** and, per the discriminator below, of "before any side effect".
  - **THE "BEFORE ANY SIDE EFFECT" DISCRIMINATOR (this is the whole point — do not skip it):** the detail must describe the CONSENT gate, **not** the unknown connection. If the detail mentions the connection id, the consent check ran AFTER the handler and the row is a **FAIL** of "before any side effect" even though the code read `consent_required`-adjacent. Quote the detail verbatim.
  - **`pg_database_reset` IS NEVER ALLOWED PAST THE GATE IN ANY ROW.** It is destructive (it destroys the env database). It appears only as an unconsented refusal (here and F-7.20) and as a declared capability in the projection (F-7.16). A round that resets the database to "prove" consent is a plan violation.
  - **EDGE:** an app whose rejected promise is swallowed (no `[data-refusal-code]`, no rendered text) is a FAIL of AC-2's displayable-refusal clause. Two log entries for one attempt is a FAIL (no fallback path).

- [ ] **F-7.18 (R-4.2 / R-4.4) [live][NEW] — AC-4: granting lifts the gate, revoking re-imposes it, with NO restart and NO window reload.** Fixture `qa3146-consent-a`, open. Record the document line's `mount=` and `loaded=` before touching the host.
  - **STEPS:** (1) read the baseline `[data-qa3146-consent]` line (expect `state=consent query=consent_required`); (2) click **A's** `[data-testid="installed-apps-consent-grant"][data-app-id="qa3146-consent-a"][data-capability="high-risk.database-query"]` (selector by **both** data attributes — A declares two capabilities, so a position-based pick can grant the wrong one, which is the single worst outcome this surface can produce); (3) wait ≤ 5 s (the fixture polls every 2 s) for a new `[data-assertion="F-7.18"]` line; (4) click the same pair's `[data-testid="installed-apps-consent-revoke"]`; (5) wait ≤ 5 s for the next line.
  - **EXPECTED:** the lines are, in order:
    `PASS F-7.18 transition consent-to-granted query=<anything but consent_required> … mount=<the SAME mount> reload=no`,
    `PASS F-7.18 transition granted-to-consent query=consent_required … mount=<the SAME mount> reload=no`.
    So the gate **lifts** without a reload and **re-imposes** without a reload: every `mount=` on every transition line equals the document line's `mount=`, `loaded=` is unchanged (quote both), the window label is unchanged and the host PID is unchanged. A `FAIL RELOAD document-reloaded …` line anywhere in the document means an in-window reload happened — a FAIL of R-4.4. The row's chip word flips **`Not allowed` → `Allowed`** on the grant and back on the revoke, the control's testid flips `-grant` → `-revoke` **in the same DOM slot**, and the pair's `role="status"` line re-announces the matching copy (`CONSENT_ENABLED_LINE` / `CONSENT_BLOCKED_LINE`).
  - **NOT-OPTIMISTIC (state it):** between the click and the host's settle the chip must still read `Not allowed` and the pressed button carries `loading`+disabled while the **other** control stays live — a chip painted `Allowed` before the host wrote the grant is the UI lying about a security fact (S2).
  - **PRE-AUTHORIZED DISCLOSURE (G-271 / G-440 — the expected value is the AC's own wording, not a tighter one).** The granted leg asserts the **absence of the consent refusal**, i.e. that the gate lifts and the call reaches the handler — **not** a successful high-risk effect. Reason, stated so nobody improvises one: every declared high-risk action's *success* needs user data or is destructive — `db_query_execute`/`db_result_page` need a user-configured saved connection with a stored credential, `spawn_terminal_session` needs a configured CLI, and `pg_database_reset` destroys the database. AC-4's literal observable is *"must consent before use; without consent it is refused at runtime"*, and that is exactly what this row proves. **Do not** manufacture a connection to force a `SELECT 1` and **never** call `pg_database_reset`. (The UI/UX section's proposed row asserts a successful high-risk action instead; that leg is not producible in this slice — raised in `## Discussion`, and the bound form is this one.)
  - **EDGE:** a call that is still `consent_required` after the grant is a FAIL. A grant that only takes effect after a window reload is a FAIL of R-4.4 and its mount id will show the reload — that is why the stamp is recorded. A granting click on the **wrong** pair (reset instead of query) is a FAIL of the pair keying, not a product defect — re-drive with the both-attribute selector.

- [ ] **F-7.19 (R-4.2) [live][NEW] — AC-4: a grant to A never enables B, in the same snapshot.** Fixtures `qa3146-consent-a` and `qa3146-consent-b`, **both open**, with F-7.18's grant to A held. **Open (or re-open) B AFTER the grant** so its probe line is produced post-grant.
  - **READ** `[data-assertion="F-7.19"]` on `installed-qa3146-consent-b`, and `[data-assertion="F-7.18"]` on `installed-qa3146-consent-a` in the same snapshot.
  - **EXPECTED:** B reads `PASS F-7.19 codes=consent_required appId=qa3146-consent-b` — refused, with B's OWN derived id — while A's line shows the `consent-to-granted` transition (A's identical call is **not** `consent_required`): one snapshot, two documents, opposite outcomes. The settings surface simultaneously shows A consented and B not (`consented` arrays quoted from `installed_apps_list`).
  - **EDGE:** B resolving (or returning a non-consent error) after a grant to A is a **total FAIL** of AC-4's third clause. A consent file whose `grants` map carries one key per app — quote it: `{"qa3146-consent-a": ["high-risk.database-query"], "qa3146-consent-b": []}` shape (A's key present, B's key absent or empty).

- [ ] **F-7.20 (R-4.2 / R-4.5) [live][NEW] — AC-4: the grant is the SPECIFIC capability, never a blanket.** Fixture `qa3146-consent-a`, open, holding ONLY the `high-risk.database-query` grant (grant it in F-7.18 and do not revoke).
  - **READ** `[data-assertion="F-7.20"]`; it is produced by the fixture **only once it observes the query leg granted** — it then drives `pg_database_reset` exactly **once** in that document (a knowingly-destructive action, fired once per document, as the last probe).
  - **EXPECTED:** `PASS F-7.20 codes=consent_required capability=high-risk.database-reset queryGrant=held` — the query leg is **not** `consent_required` (that is the precondition `queryGrant=held`) while the reset leg **is** `consent_required` on the RESET capability: one app, two high-risk capabilities, independent gates, never past the reset gate. A `FAIL F-7.20 … FATAL: pg_database_reset was ALLOWED past the consent gate` line is a **total FAIL** — stop and report immediately (the environment database has been destroyed; do not re-run the row).
  - **EXPECTED (the store, quoted):** read `<FREDO_DATA_DIR>/installed-apps-consent.json` and confirm `grants["qa3146-consent-a"]` is exactly `["high-risk.database-query"]` (one entry, sorted) — `version: 1` present.
  - **EDGE:** a store that records `["high-risk.database-query","high-risk.database-reset"]` after one grant is a FAIL of "specific". A reset leg that is allowed through is a **total FAIL** and also destroys the environment — if it ever resolves, stop and report immediately.

- [ ] **F-7.21 (R-4.5) [live][NEW] — a grant for an UNDECLARED capability is refused and records nothing.** Drive from `main`. Consent file quoted byte-for-byte before and after.
  - **DRIVE:** `installed_app_consent_grant{appId:"qa3146-consent-b", capability:"high-risk.database-reset"}` (B does **not** declare reset), then `installed_app_consent_grant{appId:"qa3146-does-not-exist", capability:"high-risk.database-query"}`.
  - **EXPECTED:** the first rejects with the FROZEN installer vocabulary — `manifest_invalid_field` and a detail naming the capability (record the exact error object); the second rejects with `id_not_installed`. The consent file is **identical** before and after (quote both, or is absent both times). B's `db_query_execute` behaviour is unchanged (`consent_required`).
  - **EDGE:** a grant silently recorded for an undeclared capability is the *back door into a blanket grant* — a total FAIL. Do **not** FAIL the row because the code is `manifest_invalid_field` (reusing the frozen vocabulary is the design: the 22 codes must not grow).

- [ ] **F-7.22 (R-5.1) [live][NEW] — AC-5: scope and consent survive a RESTART; nothing in memory is authority.** This row **must** restart the instance.
  - **STEPS:** record the baseline snapshot (A's grant held for query only; B unconsented; `mission` denied on `monitor_sessions`; A's own `notes` read OK). Then, holding the SAME env id and slot (G-328 — **never the `Restart` verb**): `powershell -File .opencode/scripts/dev-env.ps1 -Action Down -EnvId <id>` then `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3146 -EnvId <id> -EnvSlot <n>`. `Down` **keeps** `FREDO_DATA_DIR` (documented, `dev-environment` SKILL) — that is what makes this a persistence proof, not a wipe test. Budget the 3–5 min first paint (G-386) and attach a NEW driver session.
  - **EXPECTED, after the restart:** the same apps are listed; A's projection reads `consented:["high-risk.database-query"]` (re-read from disk — the process that held the grant in memory is gone); opening A produces a fresh document whose `[data-qa3146-consent]` line reads `state=granted query=<not consent_required>` (so the query leg is **not** `consent_required`) and whose `[data-assertion="F-7.20"]` reads `PASS … capability=high-risk.database-reset` (the reset leg is **`consent_required`** — the grant was per-capability, so it survived correctly and only what was granted survived); B reads `[data-assertion="F-7.19"] codes=consent_required`; A's `[data-assertion="F-7.7"]` reads `PASS F-7.7 codes=ok` (its own `notes` read returns); `mission` reads `[data-assertion="F-7.11"] codes=scope_denied,…` on `monitor_sessions`.
  - **WHY THIS IS THE PROOF:** the restarted process has no in-memory state at all, so everything that still holds was re-derived from disk — this is the live form of "no in-memory grant survives as authority" (R-5.1) and the substitution recorded for the INERT reinstall clause (F-7.25).
  - **DETAIL (mandatory, post-restart):** the two refusals this row observes must also be read by cause.
    On the re-opened A document read the refusing call's `[data-call-log]` entry — for the reset leg
    (`pg_database_reset`, `consent_required`) quote `refusal.detail` and require `You have not allowed this capability for this application yet. Allow it in Settings > Installed applications, then try again.` verbatim (a detail that describes the reset instead of the consent gate is the FAIL F-7.17's discriminator names). On `mission` read `[data-assertion="F-7.11"]`'s first entry and
    require the scope sentence `This application can only reach the data tables it declared for itself.`
    byte-identical — a post-restart detail that differs from the pre-restart one means the process is
    re-deriving it from different inputs (report it). A body-failure detail (`record […] does not
    exist …`) anywhere here is a FAIL.
  - **P-1 AFTER THE RESTART (mandatory, this is the row's second half):** re-run the AC-6 preamble's P-1
    recipe against the restarted process and quote all five readings (`0` → write resolves → exactly one
    row → updated value → cleanup `0`). The fresh process has no in-memory state, so a held P-1 here
    proves the declared-table insert path is re-derived from disk too — and a P-1 that fails post-restart
    while it held pre-restart is a FAIL of "nothing in memory is authority", not an environment quirk.
  - **EDGE:** a post-restart consent that has drifted (query granted AND reset granted) is a total FAIL. A restart that loses the install root means `Up` did not carry the env id — disclose it as an ENVIRONMENT defect, never as a product FAIL. Leave the env RUNNING afterwards (the round's other rows and the auditor reuse it).

- [ ] **F-7.23 (R-5.3) [live][NEW] — a second window of the same app IS the same app.** Fixture `qa3146-app-a`, open; record the document line's `mount=`.
  - **STEP:** `installed_app_open{appId:"qa3146-app-a"}` from `main` while the window is already open.
  - **EXPECTED:** `tauri_manage_window list` shows **exactly one** `installed-qa3146-app-a` (never two); the existing window is focused and its document line still carries the **SAME** `mount=` (a rebuilt window would carry a new one), and `[data-assertion="F-7.24"]` in that same document still reports `otherAppId=qa3146-app-a` — i.e. the identity is the same for both open requests.
  - **EDGE:** two windows with the same label would break the label-as-identity premise — a total FAIL. A second window with a DIFFERENT label (e.g. `installed-qa3146-app-a-2`) is a FAIL of "a second window of the same app is the same app", because that label would derive a different app id.

- [ ] **F-7.24 (R-5.4 / R-5.3) [static+live][NEW] — a forged identity is impossible — and this row states exactly what the round CAN observe.** Both legs mandatory; neither answers for the other.
  - **STATIC LEG (the mechanism):** (a) `capabilities/installed-app-commands.json` grants exactly `allow-installed-app-invoke` — quote it (F-7.4 quotes the whole file); (b) `core:window:allow-create` appears **only** in `capabilities/default.json`, and that file's `windows` array is `["main","terminal","doom","app-*"]` — quote both, so an installed document has no window-creating permission at all; (c) enumerate every call site of `installed_app_window_label` across `apps/tauri/src-tauri/src` (grep + directory listing) and confirm the ONLY producer is `open_installed_app_window`, which `installed_app_open` reaches only after `resolve_open_target` verified the install record; (d) quote the signature of `installed_app_invoke` showing the identity source is `webview: tauri::Webview` and **not** a field of `InstalledAppCallRequest`.
  - **LIVE LEG (what the tester can actually observe).** Read `[data-assertion="F-7.24"]` on `installed-qa3146-app-a`; the fixture drives three reads: own `notes` with no `applicationId`, `qa3146-app-b`'s `records`, and a non-existent id `qa3146-ghost`. **EXPECTED:** `PASS F-7.24 codes=ok,scope_denied,<refused> otherAppId=qa3146-app-a ghostAppId=qa3146-app-a` — leg 1 resolves as A (identity injected); legs 2 and 3 are **refused** (leg 2 is `scope_denied`; leg 3's code is the product's own taxonomy for an unknown target and the row binds only "refused", never a code) and the refusal's `appId` is **`"qa3146-app-a"` in both cases** — the derived id, never the payload's, never `qa3146-ghost`.
  - **DETAIL (mandatory, legs 2 and 3 — this row's `appId` claim is only half the identity proof):** read
    each refusing call's own `[data-call-log]` entry and quote `refusal.code`, `refusal.appId` and
    `refusal.detail`. Leg 2 (`qa3146-app-b` + `records`) ⇒ `scope_denied` with
    `This application can only reach the data tables it declared for itself.` Leg 3 (`qa3146-ghost`) ⇒
    quote whatever code the product uses (only "refused" is bound) and require its `detail` to be
    **either the same scope sentence or a sentence naming no application other than the caller** — a
    detail that confirms or denies the existence of `qa3146-ghost`, or that names any other id, is a
    FAIL of the no-caller-supplied-identity NFR *and* of F-7.31's non-oracular clause. A body-failure
    detail (`record […] does not exist …`) is a FAIL here.
  - **D-A POSITIVE CONTROL (P-1, mandatory):** cite the AC-6 preamble's P-1 record held in this round, so
    leg 1's `ok` is a resolve against a table a write actually landed in (two empty readings cannot prove
    it). A round with no held P-1 leaves this row UNVERIFIED.
  - **EXPLICIT LIMITATION (record it; a verdict claiming more is malformed on its face).** The tester **cannot** observe a forged window LABEL: no installed document can create a window (leg (b)) and the driver has no verb that mints a window with a chosen label. So the round's evidence is (i) the absence of a window-creating grant, (ii) the single minting site, and (iii) the derived `appId` in every refusal. State it in those three terms.
  - **EDGE:** a refusal whose `appId` echoes the REQUESTED id is a total FAIL of the no-caller-supplied-identity NFR. Any `core:*` permission appearing in the installed capability is a FAIL of leg (a) and of F-7.4.

- [ ] **F-7.25 (AC-1 / AC-5, the "reinstalled" clause) [INERT][NEW] — recorded, never driven.** **Statement (quote it in the verdict):** the installer refuses an id whose directory already exists (`already_installed`, one of the 22 frozen codes) and **no remove / uninstall / reinstall path ships in this slice** (#3144 owns the management surface), so the *"or an application is reinstalled"* half of AC-1 and AC-5 is **structurally unexercisable here**. The live form of the same guarantee in this slice is **F-7.22** (restart) + **F-7.27** (per-call re-derivation) + **F-7.7** (close/re-open re-verification); the code contract is reinstall-ready (consent keyed by installed id, data namespaced by id) so #3144 lights the clause up with no contract change. **Do not reword or narrow the AC.**
  - **BOUND PROBE (cheap, and it is evidence that the clause is inert — not a substitute for it):** attempt `installed_app_install{archivePath:"<out>/qa3146-app-a-1.0.0.zip"}` a second time ⇒ `already_installed`; the first install is intact (still listed, still openable, files untouched — `record.json` byte-identical before/after); and **A's consent grant survives the refused reinstall** (re-read the projection).
  - **EDGE:** a round that reports the reinstall clause as PASS or FAIL is wrong in both directions — it is INERT, and the #3144 slice owns the live form.

- [ ] **F-7.26 (NFR fail-safe default) [live][NEW] — no declaration means NO reach, never "everything except a deny list".** Fixture `qa3146-no-capabilities` (no `capabilities` key at all), open.
  - **READ** `[data-assertion="F-7.26"]`; the fixture drives `application_data_read` of its own id + `notes`, `application_data_declare{declarations:[]}`, and `pg_database_reset`.
  - **EXPECTED:** `PASS F-7.26 codes=action_not_declared,action_not_declared,action_not_declared` — all three refused `action_not_declared` (the CAPABILITY is undeclared — not `scope_denied`); the projection's `declared`/`highRisk`/`consented` are all empty; the settings entry renders no consent section (F-7.16).
  - **DETAIL (mandatory, all three calls — this row's whole claim is WHY they were refused):**
    the row's claim is *which gate* fired (the CAPABILITY gate, not the scope gate), and a code alone is a
    token. Read each of the three `[data-call-log]` entries by `action`
    (`application_data_read`, `application_data_declare`, `pg_database_reset`) and quote
    `refusal.code` + `refusal.detail`. **Expected `detail` for all three:
    `This application's package did not declare the capability this action needs.`** A
    `scope_denied` (with the scope sentence) here is a FAIL — the package declared nothing, so the
    capability gate must fire first; a scope sentence instead means the row's fail-safe claim is being
    answered by a different gate, which is not this NFR.
  - **SAME-ROUND CONTROL (mandatory, and it is now non-vacuous by construction):** `qa3146-app-a` —
    which does declare — reads `[data-assertion="F-7.5"]` with all five assertion steps `ok`, **and** the
    AC-6 preamble's P-1 record is held in this round (`0` → write resolves → exactly one row → updated
    → cleanup `0` on A's own declared table). So "everything refuses" is not the pass condition, the
    fail-safe claim is about the DECLARATION, and a round with no held P-1 leaves this row UNVERIFIED
    rather than PASS.
  - **EDGE:** a package with no `capabilities` key that can reach ANY action is a total FAIL of the fail-safe NFR. A refusal code of `caller_unknown` here means the tier classifier mis-read the label — report the label you saw.

- [ ] **F-7.27 (NFR complete mediation / R-3.5 / R-4.4) [live+unit][NEW] — the decision is re-derived on EVERY call; nothing is cached at subscribe, mount or window-open time.** Three legs; A and B are the same legs F-7.18/F-7.19 drive, but this row owns the *re-derivation* claim and its instrument.
  - **LEG 1 — consent, live, no restart and no reload:** F-7.18's grant → revoke cycle, read as the fixture's own `[data-assertion="F-7.27"]` lines (`transition consent-to-granted …` then `transition granted-to-consent …`), **every one carrying the SAME `mount=` and `reload=no`** (quote them). A per-mount-cached decision cannot flip this way without a reload.
  - **LEG 2 — the decision follows the FILE (the decisive lever):** with A's document **open** and the query grant held, rewrite `<FREDO_DATA_DIR>/installed-apps-consent.json` to `{"version":1,"grants":{"qa3146-consent-a":[]}}` (write the whole file with that shape; quote it before and after), then wait ≤ 5 s **in the same document**: the fixture's poll re-derives the decision and publishes a new `PASS F-7.27 transition granted-to-consent query=consent_required … mount=<UNCHANGED> reload=no` line. Restore the grant through the UI and wait ⇒ a further `consent-to-granted` line, same `mount=`. Expected: the verdict tracks the FILE, which is only possible if it is re-read per call. If the store serves a cached decision (no new line, or a `FAIL RELOAD` line), record the exact sequence and FAIL the complete-mediation NFR — do not retry into a different shape.
  - **LEG 3 — declarations, bound as a UNIT pin (say so, do not improvise a manifest edit):** a runtime declaration mutation **cannot** be driven — the manifest lives inside the integrity-pinned install root, so editing it trips `integrity_mismatch` (F-4.4) rather than proving a re-read. The declaration re-read is therefore bound to **F-7.3**'s unit pin (the dispatcher re-reads the install record and consent on every call) plus **F-7.7** (close/re-open re-verifies and re-materializes declarations). Explicitly: **no tester may edit `manifest.json` to test this leg.**
  - **EDGE:** a leg-2 pass produced while the window was CLOSED and re-opened proves nothing (that is F-7.22's restart path) — the mount id is how you know. A refused action that was refused for a *different* reason than `consent_required` after the file edit is not this row's observable — quote the code.

- [ ] **F-7.28 (NFR diagnosability — the wire shape) [live][NEW] — every refusal is a structured object whose OPTIONAL key is genuinely absent when it does not apply (G-413).**
  - **EXPECTED (present-optional case):** the refusal object for F-7.17's **query** step, read from its `[data-call-log]` entry (`ok:false` → `.refusal`), parses to **exactly five keys**: `action`, `appId`, `capability`, `code`, `detail` — quote the sorted key list; all five values are non-empty strings; `appId` is the derived id; `detail` is human-readable prose (not a bare code, not a stack trace).
  - **EXPECTED (absent-optional case):** the refusal object for F-7.9's **first** step (`save_control_setting`, `action_not_grantable`), read from its `[data-call-log]` entry, parses to **exactly four keys** — `action`, `appId`, `code`, `detail` — and the JSON object has **no `capability` key at all**: assert the key's PRESENCE, not its value (`capability` is not `undefined`, it is not `null`, and it is not `""`). Feeding that exact object into the frontend copy-map lookup (`isCapabilityRefusalCode` + `CAPABILITY_REFUSAL_COPY`) must still resolve the code.
  - **EXPECTED (install-side diagnosability):** F-7.15's two install refusals each name their exact field path — quote both.
  - **EDGE:** a serializer that emits `"capability": null` passes a type-level check and breaks a consumer that distinguishes presence — that is why both cases are asserted on the serialized payload in the same round. A `detail` that reads like a machine token is a FAIL of the diagnosability NFR.

- [ ] **F-7.29 (R-4.1 — the consent-section STATE MATRIX) [live+static][NEW] — absence is three different facts and must not be conflated.**
  > Re-homed from the UI/UX section's proposed `F-7.1`/§5 (that id now belongs to the resolver row). The
  > surface shape is the UI/UX contract's: a pane-level section, after the list and before the
  > limitations footer, one row per **application**, one control line per declared **high-risk
  > capability**. Assert the **chip WORD** (`Allowed` / `Not allowed`) as the state; `data-consent-state`
  > is an **open adjudication request** in `## UI/UX Expert` §2 and is therefore **not** asserted here.
  - **S0 — no declaration.** With no installed app declaring a high-risk capability, `[data-testid="installed-apps-consent-section"]` is **ABSENT** (not an empty heading, not an empty `role="list"`), and it adds **no tab stop** (Tab from the install button must not land on it).
  - **S1/S3 — declared-not-consented / consented.** F-7.16 owns the render; this row owns the pair's **mutual exclusivity**: at any instant a `(app, capability)` pair has **either** `…-consent-grant` **or** `…-consent-revoke`, in the **same DOM slot**, so the layout does not reflow on toggle. Quote both states for one pair across F-7.18's cycle.
  - **S4 — just revoked.** No distinct "revoked" chrome: after a revoke the row reads exactly like S1 (chip `Not allowed`, control `Allow`) and the pair's `role="status"` line re-announces `CONSENT_BLOCKED_LINE`. A sticky "revoked" badge is a FAIL (one fact, one representation).
  - **S6 — list not yet read.** With `loading && !settled` the section renders **nothing**: a skeleton would have to guess whether any app declares high-risk. **This is a STATIC/UNIT clause, not a live race** — the live window is ~ms and not reliably observable, so it is verified in the component unit test (F-7.34) and by reading the render path (quote the `status` guard). Do not attempt to catch it live and record a spurious PASS.
  - **S7 — list read failed.** Drive the shipped failure lever (`functional.md` **F-6.4**: put a non-directory file where a listing entry must be, then re-open the pane). **EXPECTED:** the consent section still describes **the same last-known snapshot the list itself is still showing** — if the list renders entries, the section renders rows for those entries; only when there is **no** snapshot at all is the section absent. A list on screen with no consent section beside it is a **FAIL**: it reads as "none of these ask for anything", which is a false claim. Explicitly: S7 must never be reported as S0.
  - **S8 — unrecognised high-risk id.** An id this build's union does not know renders `UNKNOWN_CAPABILITY_LINE` verbatim + the raw id in mono + chip `Not allowed`, and **no control at all** (Fredo cannot honestly ask for a scope it cannot read) — and it is **never omitted**. **UNIT-ONLY, and say why:** the installer refuses an unknown capability id at install (F-7.15), so a live installed app carrying an out-of-union id is **not producible**; assert the render branch in F-7.34 with a crafted projection. Do not attempt to install one.
  - **EDGE:** S0 vs S6/S7 must never be confused — three different facts. A section rendered for an app declaring only `data.tables` is a FAIL (S0 per-app).

- [ ] **F-7.30 (R-4.1 / R-4.2 — the CONSENT COPY + accessible-name contract) [live+static][NEW].**
  > Re-homed from the UI/UX section's proposed `F-7.2`.
  - **EXPECTED (verbatim copy, per declared capability):** each control line's body sentence equals `CAPABILITY_CONSENT_COPY[capability].consequence` **verbatim** (quote it for both of A's capabilities — they are DIFFERENT sentences); the chip word is `Allowed` / `Not allowed`; the visible button label is `Allow` / `Revoke`; the section heading is `CONSENT_SECTION_HEADING` verbatim and the intro/scope lines are `CONSENT_SECTION_INTRO` / `CONSENT_SCOPE_LINE` verbatim.
  - **EXPECTED (accessible names, AC-4's wording):** unconsented ⇒ `` `Allow <displayName> to <verb>` ``; consented ⇒ `` `Revoke permission for <displayName> to <verb>` ``. Quote both. Each **contains its visible label** ("Allow"/"Revoke") so voice control still matches (WCAG 2.5.3) — and each contains the application name **and** the capability's verb, so two apps' controls are never indistinguishable.
  - **EXPECTED (copy rules, grep-checkable — UI/UX §3 rules 1-4):** (a) **no verification or safety vocabulary** anywhere in the section or in either copy map — the exact banned tokens are `verified`, `signed`, `publisher`, `trusted author`, `safe`, `secure`, `sandbox`, `read-only`; (b) no blanket scope — `allow`/`grant`/`revoke` never appear without an application and a capability in the same sentence or accessible name; (c) an in-section sentence is Fredo's (second person to the user) and an app-side sentence is about the application in the third person; (d) the `scope_denied` copy **never names or implies another application**.
  - **SCAN SCOPE (G-430/G-431 — this is where the guard would otherwise lie).** The scan root is the **two changed UI files** (`InstalledAppsSettings.tsx` and the new `capabilityRefusals.ts`), not the repo: the banned token `sandbox` legitimately appears in *this suite* and in product docs where the spec says NO OS sandbox exists, and the token `read-only` appears in the DB-client copy discussion. The allowlist is `.opencode/tests/**` + `docs/**`. Report the **raw-token count** beside the stripped count, and run the non-vacuity control: a seeded one-line hit inside the scan root is caught, and a synthetic hit outside it is not scanned.
  - **EDGE (G-466 — read this before writing the ban).** The plan **requires** the sentence `Allowing or revoking here never removes an application or its data.` — so the ban is the explicit eight-token list above, **never** a stem search on `remove`/`revoke`. A ban that reddens on the required sentence is a plan defect, not a product defect. `CONSENT_ENABLED_LINE` is a claim about R-4.4's timing only — it must not be read as a claim that the app is running.

- [ ] **F-7.31 (R-2.1 / R-2.3 / R-3.1 — the refusal-detail LEAK BOUNDARY and the no-host-surface clause) [live][NEW].**
  > Re-homed from the UI/UX section's proposed `F-7.5`, which found a clause the Architect's own r-ids do not state explicitly and which AC-3 needs: a refusal is caused by the CALLER, so it may describe the caller only. This row and F-7.11/F-7.13 are one proof in two halves — they prove *no data*; this proves *no information*.
  - **READ** `[data-assertion="F-7.31"]`; the fixture drives three legs: name `qa3146-app-b`'s `records`; name the caller's own id with the table `records` (which exists for nobody); name `mission` + `monitor_sessions` (the composed collision of F-7.11). Then quote all three `detail` strings from `[data-call-log]` (same capture).
  - **EXPECTED (every leg `scope_denied` — `PASS F-7.31 codes=scope_denied,scope_denied,scope_denied`; then quote all three `detail` strings).** The fixture's own `s1Leak`/`s2Leak`/`s3Leak` checks already fail the line if any `detail` contains `mission-monitor` or `feature_mission_monitor_sessions`, and `notOracular` compares leg 1's and leg 2's `detail` after stripping the caller-supplied values — the clauses below are the reader's own read of the quoted strings:
    - `detail` **may** name: the caller's own `appId` (`qa3146-app-a`), the `action`, the caller's own requested table name, and the missing/mismatched capability. Echoing a value the caller itself supplied is not a disclosure.
    - `detail` **must NOT** contain: another application's id (specifically `qa3146-app-b` and **`mission`**), another application's table name (`records`), the built-in id `mission-monitor`, the composed physical name `feature_mission_monitor_sessions`, an enumeration of known ids, or a count of installed applications. Nor the phrases `belongs to` / `owned by` followed by anything but the caller.
    - **NON-ORACULAR (the sharpest clause — this is an enumeration-oracle defence):** leg 1 ("that table exists and is someone else's") and leg 2 ("no such table") must be **indistinguishable** by their refusal: compare the two `detail` strings and require them **identical except for the caller's own echoed values** (the table name it supplied). Any wording that differs between "exists and is not yours" and "does not exist" lets an installed app probe candidate ids and learn which applications are installed — exactly the data AC-3 protects.
  - **EXPECTED (NO HOST SURFACE — UI/UX §4).** Before and after each refusal, capture the host's rendered state: a `tauri_webview_dom_snapshot` of `main` and a count over a stable pane selector with Settings → Installed applications open. **EXPECTED:** identical — the refusal adds **zero** rendered nodes outside the child. No toast, banner, badge, counter, or entry-row change; the pane's only refusal surface stays the list-read/install verdict it already owns. An app's refusal must never be attributed to another application's row, section or notification.
  - **EDGE:** a `detail` that names `monitor_sessions`'s composed physical name leaks the collision — FAIL. Leg 3's detail naming `mission-monitor` is the sharpest possible violation (it confirms WHICH built-in collided). A host toast added "for diagnosability" is a FAIL of this row even though it feels helpful — the leak boundary is the AC. `appId` echoing the caller's own id is explicitly **allowed**.

- [ ] **F-7.32 (map pins — the copy tables and the code guard) [unit][NEW].**
  > Re-homed from the UI/UX section's proposed `F-7.6`.
  - **EXPECTED:** `CAPABILITY_CONSENT_COPY` is **exhaustive over the high-risk ids** — the `HighRiskCapabilityId` type is `CapabilityId` filtered to the `high-risk.` prefix, so an id beginning `high-risk.` with **no** copy entry must fail the **typecheck** (quote the filtered union and the passing build). Each entry has a **distinct, non-empty** `consequence` and a **distinct, non-empty** `verb`; no `verb` contains a raw capability id; `data.tables` is **not** in the union (never consentable, never rendered).
  - **EXPECTED:** `CAPABILITY_REFUSAL_COPY` is exhaustive over the **six** codes and every sentence is **distinct** (two codes sharing one sentence must redden — an "all non-empty" assertion alone passes that defect); `isCapabilityRefusalCode` rejects an unknown code; the unknown-code fallback sentence is non-empty.
  - **REDDEN CONTROL:** pre-change these modules do not exist, so the test target does not compile.
  - **EDGE:** a `Record<string, …>` (instead of the filtered union) passes every runtime assertion here and loses the compile-time guarantee — quote the type, not just the map.

- [ ] **F-7.33 (a11y + tokens on the consent surface) [static][NEW].**
  > Re-homed from the UI/UX section's proposed `F-7.7`. Complements **N-7** (which covers the loading/failure panels) and does not replace it.
  - **EXPECTED (structure):** both controls are real `<button>`s (Chakra `Button`) at the two testids, in DOM order after the row's text — **no `<div>` click handlers, no `tabIndex`, no key handling of our own**. Accessible names per F-7.30. The chip's **word** carries the state; the glyph differs in shape **and** presence, and the capability id is text — **never colour-only**.
  - **EXPECTED (live regions):** the pair's state line carries `role="status" aria-live="polite"`; **only** `[data-testid="installed-apps-consent-refusal"]` is `role="alert"`. `aria-live="assertive"` on the state line is a FAIL (the user caused that change; it is not an emergency).
  - **EXPECTED (landmark + headings):** the section is `<section aria-labelledby>` its own `id`'d `h3`, inside a pane whose heading is `h2` — reachable by heading navigation. Absent section ⇒ **no tab stop** (assert the same way the pane asserts it for the limitations block).
  - **EXPECTED (tokens):** **zero** hex/rgba/hsl literals in the changed files; tints via `tint('var(--status-success)', 12)` / `tint(var, 10)`; **no alpha-append onto a `var()` reference** (`var(--x)22` is invalid CSS and silently drops the declaration). **No new token, no new colour, no contrast floor** — every legible string is `fg.default`/`fg.muted` over `bg.canvas`/`bg.subtle`, the same pairing the pre-change pane ships on the same surfaces (the G-235 control is the untouched limitations block). If a contrast ratio needs computing here, the DESIGN changed — report it, do not adjudicate a floor.
  - **EXPECTED (the shipped pin survives):** an entry row still contains **0** buttons (`row.querySelectorAll('button').length === 0` in `__tests__/InstalledAppsSettings.test.tsx`). Quote it. That pin is what keeps the consent controls in their own section rather than weakening the "registry view" contract.
  - **EDGE:** `prefers-reduced-motion` has no branch to miss (nothing animates); a fade/slide introduced here is a design change. A new focus trap, dialog, popover or portal is a FAIL.

- [ ] **F-7.34 (component unit — the consent section's refusal and unit-only states) [unit][NEW].**
  > Re-homed from the UI/UX section's proposed `F-7.8`, extended with the two states that are UNIT-ONLY by construction (S6 and S8 above).
  - **EXPECTED (S5 — consent command refused):** a rejected `installed_app_consent_grant`/`_revoke` renders `[data-testid="installed-apps-consent-refusal"]` (`role="alert"`) with `data-refusal-code`, the **`INSTALL_REFUSAL_COPY[code]`** sentence and the mono `field` chip; the row's state is **unchanged** (chip still `Not allowed` — the grant was never optimistic, so there is nothing to roll back); every control is re-enabled.
    **Assert the code + the chip, not the sentence's aptness.** `manifest_invalid_field`'s shipped sentence is a package-format claim, reused here only because the installed-app vocabulary is frozen at **22** codes; that is an **accepted imprecision** and must **not** be "fixed" by adding a 23rd code (R-8.2).
  - **EXPECTED (S6):** with `status.loading && !status.settled` the section renders **nothing** (no skeleton, no heading).
  - **EXPECTED (S8):** a projection whose `highRisk` carries an id outside the union renders `UNKNOWN_CAPABILITY_LINE` verbatim + the raw id + chip `Not allowed` + **no control**, and is **never omitted** from the list.
  - **REDDEN CONTROL:** pre-change the component has no consent section, so these assertions do not compile.
  - **EDGE:** a test that deletes or weakens the `row.querySelectorAll('button') === 0` assertion to "make room" for a control inside a row is a **design change**, not a test fix — FAIL the row and report it.

- [ ] **F-7.35 (instrument control — the rendered mirror really ran) [live]** — install and open **`qa3146-mirror-control`** (`installed_app_open{appId:"qa3146-mirror-control"}`), then read its mirror with the native UIA read (corroborated by a native capture).
  - **EXPECTED (all three clauses, in this order):**
    (1) `[data-qa3146-header]` reads `QA3146-FIXTURE app=qa3146-mirror-control version=1.0.0 capabilities=data.tables tables=control_probe probes=MIRROR-CONTROL` — so you know exactly which document you are reading;
    (2) `[data-qa3146-assertions]` contains **`FAIL MIRROR-CONTROL codes=ok step 1 expected refusal action_not_declared, resolved`** — the knowingly-false expectation, which proves the probes executed AND that the `FAIL` rendering works;
    (3) `[data-qa3146-summary]` reads `QA3146-SUMMARY calls=1 probes=1 done=true`.
  - **WHY THIS IS A ROW.** Every other line in this group is a `PASS`. Without a control that MUST fail, "all PASS" and "the mirror never ran / renders nothing" are indistinguishable — a blank capture would look like success. This row is the discriminator.
  - **EDGE:** a **missing** `MIRROR-CONTROL` line, or a missing header/document line, ⇒ the transport is dead: record every remaining `[data-qa3146-assertions]`-based row as **UNVERIFIED — instrument refused (mirror did not run)**, never PASS and never a product FAIL. A `PASS MIRROR-CONTROL` line ⇒ either the declared read really was refused (a **product defect**: a package cannot read its own declared table) or the mirror fabricates results — report both possibilities and fail the round's child evidence. This row is **never graded as a product AC**; it grades the instrument.

- [ ] **F-7.36 (R-1.1 / R-1.3, the W-3 declared-table INSERT path) [live][NEW] — a write naming a key that does not exist CREATES the row, and the row is read back by the HOST.** Fixture `qa3146-app-a` installed and open (so its `notes` table — primary key `id`, column `body` — is declared and materialized on open); drive from `main` with the shipped `application_data_*` commands. This row exists because the round-2 verdict's real gap was observing the write path only from the fixture's own mirror: the mirror cannot prove the shared handler body inserted anything.
  - **DRIVE (one run, in this order, quoting every result — this is P-1 plus its discriminators):**
    1. `application_data_delete {ref:{applicationId:"qa3146-app-a",table:"notes"}, key:["pc1"]}` (any
       outcome), then `application_data_read {ref:…, where:[{field:"id",eq:"pc1"}], limit:10}` ⇒
       **`rows.length === 0`** — the **`0`**; quote the whole `{version, rows, retention}` result.
    2. `application_data_write {ref:…, key:["pc1"], set:{body:"pc-insert"}}` ⇒ **resolves** (never
       rejected); quote `updated` as a reading (not adjudicated — see EDGE).
    3. the SAME read ⇒ **exactly one row** with `body === "pc-insert"` — the **`1`**, read by the HOST
       through `application_data_read`, not from the child's mirror.
    4. `application_data_write {…, key:["pc1"], set:{body:"pc-updated"}}` ⇒ resolves; the next read shows
       `body === "pc-updated"` and still **one** row (the insert path must not degrade the update path).
    5. the IDENTICAL write again (`{body:"pc-updated"}`) ⇒ **`updated === 0`** and the read is unchanged —
       the documented one-diff rule still governs (`commands.rs:183-193`); a path that reports `1` here
       rewrote an unchanged row.
    6. `application_data_delete {ref:…, key:["pc1"]}`, then the read ⇒ `rows.length === 0` (cleanup, so
       F-7.5 and P-1 stay re-runnable).
  - **EXPECTED (the INSTALLED tier, same round, same path):** A's own document reads
    `PASS F-7.5` with `rowsAfterWrite=1` / `rowsAfterDelete=0`, and the write step's `[data-call-log]`
    entry (call 3) is `ok:true` — quote its `.value` (the `updated`) and the document's `mount=`. The
    child write and the host writes above go through the SAME body, so this is one insert path seen from
    both tiers; a child write that resolves while the host read shows no row is a FAIL of the body.
  - **RE-RUN (mandatory, one second pass):** repeat the whole DRIVE once. Step 1 must read `0` again
    (a non-zero reading means an earlier leg leaked a row — report it as row hygiene, and note that
    F-7.5's own probe deletes `n1`/`n2` first for the same reason). If step 2 ever REFUSES, stop and read
    the refusal (next clause) — do not re-drive a different key to get a greener result.
  - **FAILABILITY (the pre-W-3 tree, named):** before the fix `write()` returns `record_missing_error`
    when the named key is absent (`infrastructure/application_data/commands.rs:726-728`, `762-764`), so
    step 2 is **REJECTED** with `record ["pc1"] does not exist in application 'qa3146-app-a' table 'notes'`, step 3 reads `0` again, and the child's line reads
    `FAIL F-7.5 codes=…,scope_denied,…` whose detail is that same body-failure string. Quote it (see the
    AC-6 detail table: a body failure rides under `scope_denied`) and report the insert path as NOT
    landed — never a PASS by substituting a key that already exists, and never by answering from the
    child's mirror alone.
  - **EDGE:** an insert that reports `updated: 1` while the next read shows **no** row is a FAIL of the
    handler body (quote both readings, do not pick one). An insert that overwrites an existing row
    (`body` replaced across two different keys) is a FAIL of the key mapping — verify by writing
    `pc1` then `pc2` and reading both back. A leftover row at step 6 is a row-hygiene FAIL to report
    (it breaks F-7.5's re-run), not a cleanup nit. `updated` itself is recorded, never bound, for the
    insert and update legs — the shipped contract only fixes `0` for a no-value-delta write (step 5).

## AC-8 — the authoring kit: build outside the repo, and it installs (#3145)

> **Subject.** *"An application author outside the Fredo team can build a Fredo application and load
> it into their own Fredo."* This group owns the **kit** (`@fredo/theme`, `@fredo/authoring`), the
> **authoring documentation**, the **external-developer exam**, and the two artefact drifts that
> contradict what ships. It does **not** own development mode — that is #3241's AC 3, moved there
> verbatim with its ordinal preserved. **A row here that drives, asserts or waits on a development
> badge / banner / banner band is a plan violation**: report it, do not score it.
>
> **Verification policy: LIVE**, with `[static]` rows where the observable is an artefact (the kit's
> dependency footprint, the additive pins, the claim⇄code check, the colour scan, the two drifts).
> A `[static]` leg answered live (or the reverse) is a PASS-by-substitution and is **not** a PASS.
>
> **The pre-change REDDEN CONTROL, stated once for every `[NEW]` row below.** On the current `main`
> **`packages/` does not exist** (a `packages/*` glob returns nothing) and
> **`docs/authoring-applications.md` does not exist**. So: the kit commands die with
> `MODULE_NOT_FOUND` (non-zero exit), the doc rows find no file, and `authoring-claims.md` is
> absent. **A row that is green with those paths absent is a suite defect, not a PASS.** Each row
> names its own additional control where one is needed.
>
> **The child is read the way this suite already reads it.** The installed window is unreachable by
> every `tauri_webview_*` tool (`README.md:408-420`): a child-side read is a **native UIA text read
> of the `installed-<id>` a11y tree, corroborated by a native capture**, and it is **not** a
> live-evidence token on its own. The verdict **must** carry one genuine `tauri_webview_*` receipt
> from a REACHABLE window (`main` / `app-*`) in the same round (README §6, limit 1), plus the
> `user-attachments` upload of each capture. **E-SPAN stays the named blocker stated in the
> `**E-SPAN is a NAMED BLOCKER**` paragraph at the end of *Required test data*** — this feature runs
> no OTLP producer of its own.
>
> **The parity readout grammar (UI/UX §2 — the rows cite it verbatim; the fixture is authored to it
> once).** One line in `[data-testid="authoring-theme-readout"]`, re-published every second:
> `AUTHORING-THEME app=<id> mount=<id> loaded=<iso> colorScheme=<light|dark>` then
> `bg.canvas= bg.surface= fg.default= border.default= accent.default= accent.subtle=` (C1) and
> `painted.canvas= painted.surface= painted.text= painted.border= painted.accentFill=
> painted.tintChip=` (C2/C3), with a trailing `degraded=<csv>` only when a slot read `(empty)`.
> `painted.*` are `getComputedStyle` readings of the fixture's own painted nodes — **plain markup,
> no testids**, so none of the four host-owned hooks (`README.md:144-153`) is duplicated.
>
> **What each AC1 sub-condition is scored by (the exam's four failable conditions):**
> **F1a** (a step needs a Fredo checkout) → **F-8.2** · **F1b** (a doc claim contradicted by the
> product) → **F-8.13** + **F-8.16** · **F1c** (an app that only loads after editing internals, or a
> host-internal specifier, or a refusal the doc did not let the author prevent) → **F-8.3** +
> **F-8.4** · **F1d** (the exam is **VOID**: denial control missing, or the sha256 not reproducible)
> → **F-8.1** + **F-8.5**. All four are scored; **VOID is not PASS**.
>
> **The clean-machine boundary (the verdict must reproduce it with the observed discharge).**

| # | Substitute | Proves | Does **not** prove | Discharged by |
|---|---|---|---|---|
| S1 | a fresh `.opencode/tmp/3145/external-author/` root holding only the copied kit | no checkout is on any resolution path | another machine's filesystem layout | F-8.1 |
| S2 | Node built-ins only, executed by this repo's Node | no package-manager step, no network | a different Node version / a machine with none | F-8.6 |
| S3 | the installed Fredo dev build as the host | the real product, install command, window, refusals | a release build's exact version gate (mitigated: F-8.20/F-8.21) | F-8.4, F-8.21 |
| S4 | a fresh agent session, and **no committed sample app to copy** | the doc is sufficient for someone who did not write it | that the model was never trained on this repo — **state this in the verdict** | F-8.6, F-8.13 |
| S5 | permission-denied (preferred) / brief-restricted (fallback) author profile | the author did not read internals | a determined agent with unrestricted tools | F-8.1 |

> **The exam's ${KIT} and ${WORK} roots.** `${KIT}` = `.opencode/tmp/3145/external-author/kit`
> (the TESTER copies `packages/fredo-theme/`, `packages/fredo-authoring/` and
> `docs/authoring-applications.md` there **before** dispatch — the **key-holder** act), `${WORK}` =
> `…/external-author/work`, `${OUT}` = `…/external-author/out`. The author may read `${KIT}` and
> write `${WORK}`/`${OUT}`; it may read **nothing else in the repository**. Authoring with a bare
> `import … from '@fredo/theme'` is **not servable** (the install record is the whitelist and a bare
> specifier does not resolve in a browser): the kit's documented route is **copy the kit's
> `dist/theme.css` and/or `dist/index.mjs` into the package and reference it relatively** — if the
> doc says otherwise, that is an F-8.13 FAIL, not an author error.

- [ ] **F-8.1 (R-1.1) [live][NEW] — key-holder separation: the denial control and the input root.** Dispatch the exam agent with the brief above. Its **FIRST** action, before authoring anything, is an attempt to read `apps/tauri/src-tauri/src/applications/installed_apps/manifest.rs` lines 91-100, recorded **verbatim** as `DENIED: <text>` or `ALLOWED: <first line>`. Then run the runner and read its first line.
  - **EXPECTED:** the control reads **`DENIED: …`**, and the runner prints **`EXAM INPUTS PASS`** with every resolved input path (`--kit`, `--work`, `--out`) **inside** `.opencode/tmp/3145/external-author/{kit,work,out}`. Quote both lines.
  - **DATA:** runner per **Required test data** #5 (`ST-6`); the kit copy (#6, tester-made).
  - **EDGE:** control reads `ALLOWED: …` ⇒ the leg is scored **`brief-restricted, not permission-isolated`** — the verdict must say so and may never call it "an outsider". Control **absent** ⇒ the leg is **VOID** (F1d), not a pass and not a fail. A resolved input path outside the roots means the author was fed from the checkout ⇒ FAIL, and re-provision the root before re-driving.
  - **REDDEN:** on `main` the runner does not exist (ST-6), so no `EXAM` line is produced and the row cannot be green — quote the `MODULE_NOT_FOUND`/absent-path reading as the control.

- [ ] **F-8.2 (R-1.1) [live][NEW] — every exam step comes from the document, and the kit resolves with no install (F1a).** Read the author's transcript top to bottom.
  - **EXPECTED:** `EXAM DOCUMENTED-PATH PASS`, plus: `node ${KIT}/fredo-authoring/bin/fredo-app.mjs --help` exits **0** and prints both verbs; `… check ${WORK}/my-app --json` exits **0** with `violations: []`. **Zero** steps naming `apps/**`, `packages/**` sources, `pnpm --filter`, `cargo`, or a `@/shared/*` import. Quote the command list.
  - **EDGE:** the FIRST offending step is quoted and the whole leg is **F1a FAIL** — do not note it and continue. A step that only works because `node_modules` resolved from the checkout also fails F-8.6.

- [ ] **F-8.3 (R-1.2 / R-1.3) [live][NEW] — the produced package is self-contained (F1c, first half).** Read the produced `${WORK}/my-app/**` and the zip's entry list (`${OUT}/my-app.zip`). The exam's `S6-specifiers` step runs the **documented** command — `node <kit>/fredo-authoring/bin/fredo-app.mjs check my-app --specifiers --json`, the exact string the guide's S6 shows — and consumes its `specifiers.problems`/`specifiers.imports`; then **re-run the scan independently of the runner** — a scan you drive yourself over `${WORK}/my-app/**` plus the zip's entry list, **not** the runner's own walk.
  - **EXPECTED:** `EXAM SPECIFIERS PASS` (the runner's `SPECIFIERS` check passes the kit's `specifiers.problems` **and** the runner's independent walk, **and** the two import lists agree) **and** your own independent scan finds **zero** host-internal tokens (`@/`, `apps/ui`, `FredoApplicationClass`, `registerApplication`) **and zero bare/absolute module specifiers** — every `import`/`from` is a relative path that resolves to a file **present in the zip**. Quote the documented command, the kit's import list, and the zip entry list side by side.
  - **EDGE:** a bare `@fredo/theme` import is the most likely shape and it is **unservable** — if the doc or kit instructed it, score F-8.13, and quote the instruction. An import that resolves to a file *outside* the zip is the same failure.

- [ ] **F-8.4 (R-1.2) [live][NEW] — it installs through the NORMAL path and opens (F1c, second half).** Settings → **Installed apps** → `[data-testid="installed-apps-install-button"]` (**"Install application package..."**) → pick **`${OUT}/my-app.zip`** (the package authored from the guide, whose example id is **`com-example-my-app`**).
  - **EXPECTED:** `[data-testid="installed-apps-install-success"]` renders; `[data-testid="launcher-installed-app"][data-app-id="com-example-my-app"]` appears; opening it creates window **`installed-com-example-my-app`** whose **OS title** is the manifest `displayName` (`My application`); a **native capture** shows the app's own painted UI inside `[data-testid="installed-app-root"]`; `installed_apps_list` carries that id. Quote the entry's `version` and `enginesFredo`.
  - **EDGE:** install succeeds but the child shows `installed-app-failure` instead of painting ⇒ **F1c FAIL** — say whether the failure names a specifier the doc let the author write. A refusal ⇒ quote `data-refusal-code` + reason and classify: doc defect (the doc did not let the author prevent it) vs author defect (a documented step was mis-followed). Never accept "it installed, so AC1 passes" without the painted child. **EDGE — the id↔label contract (ST-7): a window-create failure whose detail is a `Window labels …` error is an F1c FAIL of the id↔label contract** — the id charset must be label-safe (`installed-<id>` must be a label Tauri accepts), and no author should learn this at window-open time; a package built from the guide's own example id that installs but cannot be opened is exactly this FAIL (round 1's symptom: `runtime error: Window labels must only include alphanumeric characters, -, /, : and _`).

- [ ] **F-8.5 (NFR-3) [live][NEW] — reproducible, and the installed artefact is never re-written (F1d).** Record `Get-FileHash -Algorithm SHA256 ${OUT}/my-app.zip` **before** the second pack. Then `… pack ${WORK}/my-app --out ${OUT}/my-app-b.zip` a second time.
  - **EXPECTED:** both printed sha256 values are **equal**, and `Get-FileHash` on the two files agrees **independently** of the tool's own print; `${OUT}/my-app.zip` is byte-identical to the file F-8.4 installed (hash recorded above is unchanged afterwards).
  - **EDGE:** differing hashes ⇒ **F1d VOID** (the leg satisfies nothing). A second pack written **over** `out/my-app.zip` is an **artefact-identity FAIL** (G-446): the installed bytes were replaced after every row measured on them — report it and re-drive from a fresh copy. State both paths and both hashes.

- [ ] **F-8.6 (NFR-3 / NFR-6) [static][NEW] — the kit is dependency-free, has exactly two verbs, and there is no sample app to copy.** (a) Enumerate every source under `packages/fredo-theme/**` and `packages/fredo-authoring/**`; (b) read both `package.json`; (c) run `--help`; (d) list the repo for a committed authored app.
  - **EXPECTED:** (a) **zero** `import`/`require` of a bare specifier other than `node:*` — state the raw specifier count and the hit count (G-419); (b) no runtime `dependencies` (absent or `{}`); (c) `--help` lists **exactly** `check` and `pack` — no `init`/`new`/`scaffold`; (d) **no starter template and no `work/my-app`** — no scaffolder verb, no template directory, and no author sample committed for the exam agent to copy. *(Re-cut from "no committed authored application under the tests tree": the `theme-parity` fixtures the suite itself REQUIRES by F-8.14 are sanctioned committed authored applications, so the old clause contradicted a required artefact; the property that matters — the exam agent can read only `kit/`+`work/`+`out/` — holds.)*
  - **EDGE:** a third verb is a named **non-goal** FAIL **and** it voids the exam's discrimination (the agent could copy instead of read, so S4's proves-cell collapses). A `node_modules`-dependent kit fails (a)+(b) and blinds S2 — say which specifier.

- [ ] **F-8.7 (R-2.1) [live][NEW] — parity, LIGHT: the child's colours are the host's colours, exactly (UI/UX classes C1 + C2 + C3).** Preset `select[aria-label="Theme presets"]` = `light-default`. Open the parity fixture. Read `[data-testid="authoring-theme-readout"]` (native UIA + native capture) and, **in the same capture**, the host `main` document via `tauri_webview_execute_js`.
  - **EXPECTED:** (i) **C1 token stream** — every `name=<v>` slot the line carries (`bg.canvas`, `bg.surface`, `fg.default`, `border.default`, `accent.default`, `accent.subtle`) is **byte-equal** to `getComputedStyle(document.documentElement).getPropertyValue('<the var>')` on `main`, and **non-empty** on both sides; (ii) **C2 applied colour, direct var** — each `painted.canvas|surface|text|border|accentFill` (the fixture's own `getComputedStyle(...).backgroundColor|color|borderTopColor`) is **equal** to the same property on a host probe element carrying the **same declaration** (`background: var(--body-bg)`, `background: var(--card-bg)`, `color: var(--text-primary)`, `border: 1px solid var(--border-strong)`, `background: var(--accent-primary)`), created and removed **inside the same script call** (`position:absolute; visibility:hidden; pointer-events:none`) so `main`'s DOM-snapshot node count is identical before and after; (iii) **C3 applied colour, alias** — `painted.tintChip` equals the host probe painted with the **published expression** `color-mix(in srgb, var(--accent-primary) 10%, var(--body-bg) 90%)`; (iv) `colorScheme=light`; (v) **the backdrop stipulation** — the fixture paints `--body-bg` on `html, body` and the card **on top**, because `--card-bg` may carry alpha (classic dark is `rgba(0, 0, 0, 0.3)`, `app/types/theme.ts:114`) and is only comparable over `bg.canvas`. Quote every pair.
  - **EDGE:** **tolerance is zero** — exact trimmed string equality, never rounded; a one-channel difference (`rgb(31, 31, 31)` vs `rgb(30, 30, 30)`) is a FAIL and is quoted. **`(empty)` on either side makes the comparison VOID, never a PASS** (G-469): the fixture prints `(empty)` and appends `degraded=<csv>`; "the transport sent nothing" and "the app painted nothing" must never look alike. A child painting its card over a backdrop of its own choosing is outside the guarantee and must not be used for this row.
- [ ] **F-8.8 (R-2.1) [live][NEW] — parity, DARK, with the positive discriminators.** Same read set and the same **backdrop stipulation** as F-8.7, with preset `dark`.
  - **EXPECTED:** C1/C2/C3 hold exactly as in F-8.7 (every slot non-empty on both sides, zero tolerance); `colorScheme=dark`; **and** `bg.canvas` **differs** from the F-8.7 value **and** `painted.surface` differs from F-8.7's (so the appearance really travelled).
  - **EDGE:** `(empty)` on **either** side ⇒ **VOID, never PASS** (stated here explicitly, not only in F-8.7). `colorScheme=dark` while `bg.canvas` is the light value is a FAIL of the derived scheme (`themeCapture.ts:112-116`). A dark reading **equal** to the light reading is a FAIL of the transport, not a coincidence.
- [ ] **F-8.9 (R-2.1) [live][NEW] — parity, NON-DEFAULT ACCENT.** Choose an accent that is provably not `light-default`'s: quote `accentPrimary` for `light-default` from `app/types/theme.ts:238…` and for the chosen built-in preset from its own record; **or** set `input[aria-label="Primary color"]` to a value ≠ the preset's.
  - **EXPECTED:** `accent.default` (C1) **and** `painted.accentFill` (C2) **and** `painted.tintChip` (C3) are equal host↔child and non-empty, **and** the accent readings differ from the F-8.8 state's. Quote all three values (light-default accent, chosen accent, child reading).
  - **EDGE:** `(empty)` on **either** side ⇒ **VOID, never PASS** (stated here explicitly). A Doom palette engaged is a distinct state — record which palette governed and re-drive outside Doom mode. An accent that coincides with the default proves nothing: quote both source values.

- [ ] **F-8.10 (R-2.1) [live][NEW] — the accent reaches an OPEN app with no reload.** With the app open, record the readout's `mount=`, `loaded=` and its `accent.default` / `painted.accentFill`; change the accent on the host; re-read within **≤ 10 s** (the line republishes every second).
  - **EXPECTED:** `accent.default` and `painted.accentFill` become the new value **and `mount=` is unchanged** — that unchanged `mount=` is the proof of *"without reloading it"*. No `FAIL RELOAD …` line.
  - **EDGE:** a change visible only after a reload is a FAIL, and `mount=` shows it (a new `mount` ⇒ the app reloaded). A republish of the **same** value is a FAIL of the apply. The `fredo-theme-change` **listener** half is `logic-verified` against `bootstrap.js:160-169` and pre-authorized as such — never upgraded to PASS on a listener never installed (the child-inject path is a Toolsmith item, non-gating), and the docs may not promise the event (UI/UX overclaim 11).
- [ ] **F-8.11 (R-2.2 / NFR-5) [static][NEW] — no author-supplied colour values, anywhere.** Four scans, comment/string-stripped, allowlist `transparent` / `inherit` / `currentColor` / `none`.
  - **EXPECTED (all zero hits, with each scan's file count and hit count stated):** (a) the **exam's own authored** `${WORK}/my-app/**`; (b) the committed parity fixture `.opencode/tests/installable-apps/fixtures/theme-parity/**`; (c) `packages/fredo-theme/dist/**` — every emitted value is a `var(--…)` or a `color-mix()` over vars; (d) the doc's examples.
  - **EDGE:** this row is what makes F-8.7…F-8.9 **non-vacuous** — a fixture that hardcodes the values it "reads" becomes impossible. `var(--accent-primary)22` (an alpha-append onto a `var()`) is invalid CSS and a FAIL of (c). Named colours (`red`, `white`) are literals; `transparent` is not. **This row says nothing about whether a `var()` reference is CORRECT**: "no literals" is satisfied by a wrong `var()`/expression too, and the alias class is exactly where that hides — `F-8.23` owns it. Bind both; neither answers for the other.

- [ ] **F-8.12 (NFR-1) [static][NEW] — additive within major 1, both directions.** (a) compare `packages/fredo-theme/dist/tokens.json`'s `varName` set with `app/theme/contract/tokens.ts`'s `SEMANTIC_TOKENS[].varName`; (b) compare the published `FredoAction` union with `DISPATCH_TABLE` (`dispatch.rs:87-96`); (c) compare the published `FredoRefusalCode` union with the authority vocabulary; (d) run the installer's frozen-set pin.
  - **EXPECTED:** (a) superset, with the **added** names quoted and the **removed/renamed** set **empty**; (b) eight members, **in order**; (c) six members, **in order**; (d) `cargo test --lib --locked` on `all_codes_are_exactly_the_frozen_set` green — quote the test name verbatim (G-419) and the 22 wire strings unchanged.
  - **EDGE:** a same-set **reorder** must redden (G-494) — that is why each is bound ordered. A renamed token is the additive violation even if every row still paints: quote the old and new names. **A superset passes a kit that publishes a var the host never writes** — that inverse is `F-8.24`, and the two rows are bound **together**: (a) alone can be satisfied by a name-only contract that lies.

- [ ] **F-8.13 (R-4 / NFR-4) [static][NEW] — every documented claim is checked against the product (F1b).** Read `docs/authoring-applications.md` and `.opencode/tests/installable-apps/authoring-claims.md` side by side; resolve every `satisfied-by` at the **served head**.
  - **EXPECTED:** every **normative** sentence maps to ≥ 1 claim row — the allowlist is **67 markers ⇄ 67 rows** at this tip (the six documentation gaps (a)–(f) added C-59/C-63/C-64/C-65/C-66/C-67 and re-cut C-03/C-08/C-11/C-58; re-derive the counts from the two files, never assume them); every claim's `satisfied-by` names a `file:line` (or a named mechanism) that **exists** and whose quoted text **supports** the claim; no claim states a value the product **derives** (a resolved colour, a version number, a count) instead of the mechanism. **Plus the two closed lists, both enforced:** (a) the doc contains **none** of UI/UX's eleven overclaims (§3 of the UI/UX section — "the package ships the colours", "install `@fredo/theme` from npm", any resolved value stated as a fact, parity for an unpublished var `--footer-bg`/`--gradient-*`/`--node-*`/`--edge-gradient`/`--shadow-dialog`/`--font-family`/`--font-mono`, "`ctx.theme` is live", "read `theme.colorScheme` to choose your palette", "any two tokens combine accessibly", "a theme change has no flash", "wrapping in `color-mix()` keeps it on-contract", "these names are stable forever", "you are notified of theme changes"); (b) the **doc ⇄ contract name set is two-way** — the token names the doc's colour section carries **equal** `dist/tokens.json`'s, so an **invented** name and an **omitted** name both redden (the claim-row mapping alone passes an omission). Quote the counts: sentences, claims, resolved, unresolved, doc-names, published-names.
  - **EDGE:** a sentence with **no** row is a FAIL — that is the check. A citation that resolves but does not support the sentence is a FAIL: quote both. A claim that cannot be checked at all is a **defect of the doc**, never a pass. A claim citing a line whose text has drifted (a row citing `:70-71` for a constant now at `:100`) is the same class → quote the resolved line. `--font-mono` is sharper than the rest: the host never writes it (only `PANEL_CSS` reads it with a fallback, `scheme.rs:420`), so a sentence naming it is false at **any** theme.

- [ ] **F-8.14 (R-4) [live][NEW] — the "may not rely on" list is ENFORCED, not narrated.** (a) The F-8.7 sample (published artefacts only) loads and paints. (b) Install and open each of the three negative packages: one importing `@/shared/installed-apps/store`, one importing `apps/ui/src/applications/FredoApplicationClass`, one importing a `registerApplication()` module. (c) Read the doc's may-not-rely section.
  - **EXPECTED:** each negative package **installs**, and on open the **host's** `[data-testid="installed-app-failure"]` panel renders naming that app's `displayName` — **no** app UI and **no** blank window (native capture of each). The doc lists all three with a claim row each. Quote the three failure-panel reasons.
  - **EDGE:** a package that **loads** with a `@/shared` import is a total FAIL of the list and of the two-tier boundary. The negative packages are the `theme-parity` generator's variants (ST-1 Work), one per specifier — **do not hand-roll** them, so the F-8.3 scan and the load agree. If ST-1 shipped only the positive fixture, this row is UNSATISFIABLE: report the missing artefact (ST-1), never improvise.

- [ ] **F-8.15 (R-4) [static][NEW] — the accepted limitations are stated AND true.** Read the doc's limitations section and the claim allowlist.
  - **EXPECTED:** all **nine** of NFR-4's closed list are present (own window only; cold start on first open; the module is never unloaded; no keyboard/navigation participation; no backend action of its own; own colour values forbidden; unsigned; no updates; no cross-application data), each with a claim row whose `satisfied-by` resolves. The two AC-named clauses are present **in meaning**: keyboard/navigation cites `docs/ARCHITECTURE.md:1116`; no-backend-action cites the closed eight-action set (`dispatch.rs:87-96` — `installed_app_*` absent; cross-check F-7.3 green). Quote the sentence you judged beside its citation.
  - **EDGE:** a limitation stated but **false** is a FAIL of honesty (e.g. "no data access" while the capability vocabulary exists). A limitation **omitted** is a FAIL even if nothing contradicts it. Judge **meaning**, not wording — do not fail a paraphrase.

- [ ] **F-8.16 (drift 1) [static][NEW] — `docs/ARCHITECTURE.md:1117` corrected, in BOTH directions.** (i) `grep -n 'no \`capabilities\[\]\`' docs/ARCHITECTURE.md` and `grep -n 'is \*\*#3146\*\*, not this slice' docs/ARCHITECTURE.md`; (ii) read `docs/ARCHITECTURE.md:1110-1125`.
  - **EXPECTED:** (i) each grep returns **0** hits. (ii) the limitation row now states, inside `:1110-1125`: (a) `capabilities` **is** a `manifestVersion: 1` key; (b) absent ⇒ **zero reach**, not a permissive default; (c) an installed app declares no backend **commands** — only capabilities. Check each against `manifest.rs:91-100` (8 keys, `capabilities` 8th), `mod.rs:108` (`CAPABILITY_MANIFEST_VERSION = 1`) and `dispatch.rs:87-96`; quote the doc sentence beside the source line.
  - **EDGE:** a rewrite that merely **deletes** the sentence is a FAIL — the stale row is the one an author would have read, so AC4 requires the capability truth to be **stated**. A row still presenting #3146 as future is the same FAIL. If the new prose asserts something the source does not support, that is a **new** drift: report it, do not score green.

- [ ] **F-8.17 (drift 2) [live+static][NEW] — the fixture corpus stops contradicting the parser, in BOTH directions.** (a) `node .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs --verify` then install `qa3147-bad-manifest`; (b) install `qa3146-app-a` (its manifest carries a **legal** `capabilities` object); (c) read the generator's inline `defined` array.
  - **EXPECTED:** (a) `--verify` exits **0**; the install renders `data-refusal-code="manifest_unknown_field"` **and** the `field` chip equals `package-fixtures.expected.json`'s `badManifestShape`, **and** that key ∉ `MANIFEST_TOP_LEVEL_KEYS` (quote the key set from `manifest.rs:91-100`). (b) `qa3146-app-a` installs (or is refused for a NON-manifest reason if already installed — record which) and is **never** refused `manifest_unknown_field`. (c) the `defined` array **contains** `capabilities`.
  - **EDGE:** the pre-change control, quoted: `badManifestShape` is `capabilities`, which **is** an allowed key since #3146, so the same bytes classify as `manifest_invalid_field` with `field:"capabilities"` — *"capabilities must be an object"* (`manifest.rs:628-634`). (b) already passes on the pre-change tree: it is the invariant, **not** proof the drift is gone. (c) a repaired fixture whose `defined` still omits `capabilities` lets the drift return silently ⇒ FAIL. If `build-package-fixtures.mjs` is absent, the row is UNSATISFIABLE — report the missing artefact (ST-2).

- [ ] **F-8.18 (drift 3, prior suite) [static][NEW] — the prior suite's contradiction is corrected in place.** Read `.opencode/tests/navigation-prose-retirement/regression.md` PR-5; grep it for the stale assertion; compare the two quoted strings.
  - **EXPECTED:** PR-5 re-cut in place (same id, same subject slot, **inverted** expected value): (i) it no longer asserts "no `docs/`-level authoring document exists" — the doc **exists** and PR-5 now expects it; (ii) it no longer requires `installable-apps/functional.md` to be **absent from the diff** (this spec must extend that file) — the property is that the two quoted strings are **byte-identical**, cited by **token** (`LIMITATIONS_SENTENCE` + its sentence text, and the `installable-apps` quote), not by line number; (iii) `grep -n 'No `docs/`-level authoring document exists'` over that file ⇒ **0** hits. Quote both strings.
  - **EDGE:** the stale citations are a **pre-existing** defect — `InstalledAppsSettings.tsx:70-71` is now a `client.ts` import and `installable-apps/functional.md:329` is a blank line, so PR-5(b) was undrivable **before** this spec: record that as the companion-suite defect the re-cut cures, not as this spec's regression. A re-cut that weakens (b) to "nothing to check" is a FAIL; the strings stay byte-compared.

- [ ] **F-8.19 (R-4 / NFR-6) [static][NEW] — discoverable, and no second author-facing schema.** Read `docs/README.md`'s product-documents table and diff it; grep `docs/**/*.md`.
  - **EXPECTED:** **exactly one** added table row naming `docs/authoring-applications.md` (quote it and the file's diff stat: one added line, no other table touched); and **no second hand-written manifest schema / key list / refusal table** anywhere in `docs/`, and no author-facing instruction contradicting the doc.
  - **EDGE:** a second schema copy is a FAIL even if it agrees **today** — that is the drift class F-8.17 exists for. A FAQ answer still saying "you cannot build one" is a FAIL (Sweep A's `docs/FAQ.md:38-40` disposition). A link that resolves to a missing anchor is a FAIL of discoverability.

- [ ] **F-8.20 (R-5.2) [live][NEW] — author side: `fredo-app check` names the field and the rule, and the output shape is the shipped one.** Author four package dirs in `${WORK}/` — one per case below — and run `node ${KIT}/fredo-authoring/bin/fredo-app.mjs check <dir> --json` (with `--fredo <running version>` for the engine case).
  - **EXPECTED:** (i) `displayName` **absent** ⇒ exit ≠ 0 with `{"code":"manifest_invalid_field","field":"displayName","detail":"displayName is required"}` (`manifest.rs:468-481`); (ii) `engines.fredo: ">="` ⇒ `engines_range_invalid`, `field:"engines.fredo"`; (iii) `engines.fredo: ">=999.0.0"` ⇒ `host_incompatible`, `field:"engines.fredo"`, detail naming **both** the declared range **and** the running version (`manifest.rs:929-939`); (iv) **CONTROL** — a valid manifest ⇒ exit **0**, `violations: []`. Every emitted `code` ∈ the 22 frozen wire strings (quote the set).
  - **EDGE:** a tool that fails **everything** satisfies (i)–(iii): the valid-manifest control is what makes this a test (G-469). Without `--fredo`, `check` must **state which checks it could not perform** (the range check) — quote that line; silence is a FAIL of the kit's contract. On the pre-change tree the command dies with `MODULE_NOT_FOUND` and (iv) fails ⇒ the row reddens.

- [ ] **F-8.21 (R-5.1 / R-5.2) [live][NEW] — product side: four causes, four distinct refusals, never a blank window.** Install through Settings: (a) the repaired `qa3147-bad-manifest`; (b) `qa3147-incompatible-engines`; (c) `qa3145-missing-field` (`displayName` absent); (d) an `entry_missing` package.
  - **EXPECTED:** each renders `[data-testid="installed-apps-refusal"]` (`role="alert"`, `data-refusal-code="<code>"`) whose reason equals `INSTALL_REFUSAL_COPY[code]` **and** whose detail is non-empty **and** whose field chip (present iff the error carries `field`) names the exact dotted path. The four `(code, field, detail)` triples are **pairwise different**. **No** `installed-<id>` window is created for any; the install root gains no new `<id>/`.
  - **EDGE:** two causes rendering the **same** detail is the *"generic failure"* the AC forbids — quote all four side by side. `engines.fredo` must render `host_incompatible`, **not** `engines_range_invalid` (two different author mistakes, `manifest.rs:889-898`). (c) is **ST-2's** `qa3145-missing-field` — a round without it is UNVERIFIED, never PASS (see **Required test data** #3).

- [ ] **F-8.22 (R-5.1 / R-5.2) [live+static][NEW] — the two halves agree, the doc carries the remedy, and the surface is not constant.** (i) compare F-8.20's printed `field` with F-8.21's rendered `field` for the **same** crafted manifest; (ii) read the doc's code table; (iii) with the same round, install a **valid** package.
  - **EXPECTED:** (i) the two `field` strings are **equal** — quote both. (ii) the doc's table maps each of the four codes to its **field** *and* its **remedy**, each remedy naming a change the author can make — quote the four rows. (iii) the valid package reaches the **success** strip and **no** refusal block is on screen.
  - **EDGE:** (iii) is the non-generic control — a refusal surface that always renders *something* passes (i)+(ii) and fails here. A table row with a field but **no** remedy sentence is a FAIL of R-5.2's second clause even when the code matches. **Do not** require the CLI to print a remedy: the AC puts the remedy in the doc (`manifest.rs` carries code + detail + field only).

- [ ] **F-8.23 (R-2.1 / R-2.2) [unit] — the alias class is an EXPRESSION, and a tint is never the accent.** *(Authored with the UI/UX Expert's §1 class legend; the row is QA's.)* For each of the **five name-only alias** names (`accent.subtle`, `accent.muted`, `accent.tint`, `status.errorTint`, `status.errorStrong`): read `cssVar(name)` and the `THEME_STYLESHEET` entry from `packages/fredo-theme/dist/index.mjs` / `theme.css`.
  - **EXPECTED:** every alias resolves to a **`color-mix(` expression whose operands are only `var(`** — never a bare `var(--…)`, never a literal; quote the five expressions. Then, from F-8.7…F-8.9's **same captures**, `painted.tintChip ≠ painted.accentFill` in **all three** theme states — quote the three pairs.
  - **EDGE:** an alias that returns a bare `var(--accent-primary)` passes F-8.11 (it has no literal) and **fails this row with no host-side judgement** — quoted. That is exactly the `cssVar()` defect F-8.11 cannot see. `accent.tint` is the one tint designed to host a label (the other two are translucent washes with no foreground pair) — do not bind a contrast floor to the two washes.

- [ ] **F-8.24 (R-2.1) [unit] — published-var COVERAGE: the inverse of F-8.12(a).** Render `ThemeProvider`, enumerate `document.documentElement.style`, and cross-check `packages/fredo-theme/dist/tokens.json`.
  - **EXPECTED:** every class-**A**/**D** token in `tokens.json` has its `--x` present **and non-empty** on the host document, and the five class-**N** aliases are the **only** names without their own var. Quote the counts (published names, names with a var, names without) and every miss.
  - **EDGE:** a published var that is **absent** from the host DOM reddens — that is *"the kit promised a name the product does not write"*, the one lie a name-contract package can tell while every other row is green. `--font-mono` is the standing example (the host never writes it, `scheme.rs:420` reads it with a fallback): if it appears in `tokens.json` as a published var, this row FAILS.

- [ ] **F-8.25 (R-2.2 / NFR-5) [static+unit] — the colour-literal scanner's REDDEN control.** Inject `#ff0000` into a **temp copy** of the fixture source (never the committed file), run the same scanner F-8.11 uses, then remove it.
  - **EXPECTED:** the scan reports **exactly one** violation, naming that path; with the injection removed, **zero**. Quote both runs and the temp path (under `.opencode/tmp/3145/`).
  - **EDGE:** without this, F-8.11's "0 hits" and "the scanner never ran" are the same observation — the discipline F-7.35 applies to the rendered mirror. A scanner that reports the injection **twice**, or at the wrong path, is the instrument defect: report it, do not call F-8.11 green.

- [ ] **F-8.26 (R-4 / NFR-4 / NFR-5) [static] — doc ⇄ contract, BOTH directions.** Extract the token **names** the doc's colour section carries and the names in `packages/fredo-theme/dist/tokens.json`.
  - **EXPECTED:** the two **sets are equal** — an **invented** name (in the doc, absent from the package) and an **omitted** name (in the package, absent from the doc) both redden; the section contains **zero colour literals** and **zero resolved values**. Quote both sets and their symmetric difference (which must be empty).
  - **EDGE:** a one-way check passes an overclaim; a claim-row mapping passes an omission — which is why F-8.13 binds the mapping **and** this row binds the set. A name in the doc that is a *private* custom property of the app (its own prefix, which the docs may encourage) must not be counted as a published token — say how you classified it.

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
   unit-test name). `[live]` rows quote the observable value (the `[data-qa3146-*]` line read from the
   child's a11y tree, a `getComputedStyle` string published on `[data-qa3146-theme]`, measured ms,
   window label, log line, host DOM read).
4a. **The child is read through the rendered-text mirror, never through `tauri_webview_*`.** A row
   whose line is missing, or whose `codes=` clause differs from the row's, is a FAIL; a
   `tauri_webview_execute_js` timeout against `installed-<id>` is **neither** a PASS **nor** a FAIL —
   it is the transport's known behaviour and proves nothing. **The transport itself is gated by
   F-7.35 (`qa3146-mirror-control` MUST print a `FAIL` line)** — if that control did not run, every
   mirror-based row is recorded `UNVERIFIED — instrument refused`, never PASS and never a product FAIL.
4b. **A native/UIA child read is not a live-evidence token for the audit matcher.** The verdict must
   carry, in the same round, at least one genuine **`tauri_webview_*` receipt from a REACHABLE window**
   (`main` / `app-*`) plus the `user-attachments` upload of a native child capture. With neither, the
   live leg is **refused for an instrument reason** — never upgraded to PASS on a native read alone.
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
   `## Tests Runs` comment or a committed/non-consumed path. A `.opencode/tmp/<issue>/` timeline draft
   (dev summary, triage plan, fix plan) is consumed by the transition and is never the record
   (G-415). Screenshots live under `.opencode/tmp/<issue>/e2e/` and are uploaded to
   `user-attachments` before the verdict.
7. **The #3146 group carries its own failability rule (G-476).** A `[NEW]` row's control is the
   committed diff named in the AC-6 preamble: revert `authority.rs` / `dispatch.rs` / `scope.rs` /
   `commands_consent.rs` (or read a tree where the shim is absent) and the row must redden — the
   fixture then records `no-invoke-shim` and F-7.15 records `manifest_unknown_field`. A green row on a
   tree without that diff is a **suite defect**, not a PASS.
8. **INERT clauses are recorded, never graded.** F-7.25 (the reinstall half of AC-1/AC-5) is INERT in
   this slice; a verdict that reports it PASS **or** FAIL is wrong in both directions. The live form
   of the same guarantee is F-7.22 + F-7.27 + F-7.7, and #3144 owns the rest.
9. **No row in this suite invokes `pg_database_reset` past a consent gate.** It is destructive; it
   appears only as a refused action (F-7.8, F-7.17, F-7.20) or as a declared capability in the
   projection (F-7.16). A round that resets the environment database to "prove" consent is a plan
   violation, not evidence.

### #3145 additions (the authoring kit)

10. **A row PASSES only when every clause of its EXPECTED is observed in the SAME round**, with the
    observed text/path/hash quoted. A missing fixture or a blocked env leg ⇒ **UNVERIFIED + named
    blocker** — never PASS, never a silent skip.
11. **The exam is scored, not narrated.** AC1's four failable conditions are scored explicitly —
    **F1a → F-8.2**, **F1b → F-8.13 + F-8.16**, **F1c → F-8.3 + F-8.4**, **F1d → F-8.1 + F-8.5**.
    A verdict that describes the exam without scoring all four is malformed on its face. **F1d is
    a VOID, not a FAIL** — a void leg satisfies nothing and must never be counted as a pass.
12. **The substitution is declared, always.** The verdict reproduces the five-row clean-machine
    table (S1–S5, in the AC-8 preamble) with the observed discharge per row. A brief-restricted run
    may **never** be described as "an outsider": the words *permission-isolated* and
    *brief-restricted* are used exactly as scored.
13. **Every absence is paired with a control that returns hits** (G-408/G-469): the denial control
    for isolation (F-8.1), the valid-manifest control for the checker (F-8.20), the success strip
    for the refusal surface (F-8.22), the positive parity sample for the may-not-rely negatives
    (F-8.14), and the legal-`capabilities` install for the corpus repair (F-8.17b). An absence
    clause with no control is an **instrument gap**, never a PASS.
14. **Every equality is non-vacuous.** Both sides of F-8.7…F-8.9 must be **non-empty** and the
    evidence must state the pair. Two empty readings are equal and prove nothing.
15. **A drift row is scored in BOTH directions** (F-8.16, F-8.17, F-8.18): the stale assertion is
    gone **and** the replacement is **true** against the source. "The file was edited" is never the
    evidence — the quoted source line beside the quoted doc/fixture sentence is.
16. **Artefact identity is single-writer** (G-446): F-8.4's installed zip is hashed **before**
    F-8.5's second pack, and the second pack goes to a **different path**. A leg that re-bundles
    over the installed artefact invalidates every row measured on it.
17. **No row may be answered by a native read alone.** The verdict carries **one genuine
    `tauri_webview_*` receipt from a reachable window** (`main` / `app-*`) plus the
    `user-attachments` upload of each native capture; with neither, the live legs are **refused for
    an instrument reason** — never upgraded to PASS, never failed as product rows.
18. **Development mode is NOT in this suite's scope.** `installed_app_install_development` and the
    four marking surfaces (native title, child banner, launcher badge, settings badge) are
    **#3241's**, carrying AC 3 verbatim there. A row here that drives, asserts or waits on a
    development badge/banner/banner band is a **plan violation**: report it, do not score it.

## Required test data

| # | Artifact | Owner | Notes |
|---|---|---|---|
| 1 | valid / no-manifest / bad-manifest / zip-slip / hash-tamper **/ incompatible-`engines.fredo` / reserved-`__fredo/`** packages + expected-output manifest | **ST-2** `build-package-fixtures.mjs` (all seven named in its Work line) | run once; record the output dir + the manifest's codes |
| 2 | probe app · lazy-trace app · crash-on-load app · hang-on-load app · **fail-once-then-mount app** | **ST-7** `build-behaviour-fixtures.mjs` (all five named in its Work line) | probe must expose `[data-probe-result]`/`[data-probe-error]`; fail-once needs the `sessionStorage` counter lever |
| 3 | incompatible-`engines.fredo` package · reserved-`__fredo/` package | **ST-2** (same Work line as the other five packages — owned, not an outside request) | needed by F-3.3 / F-3.5 — no row may PASS by substituting another family member |
| 4 | a non-default accent value and the presets `Light Default` / `Dark` | shipped (`Theme presets` select, `Primary color` input) | no fixture needed |
| 5 | host command pair `save_control_setting` + `get_control_setting` | shipped (`lib.rs` generate_handler) | the R-2.2 non-vacuity control |
| 6 | a mutable install root under `.opencode/*` | `FREDO_DATA_DIR` from the env manifest | needed for the integrity legs (F-4.4/F-4.5) |
| 7 | **the eleven #3146 capability fixtures** — `qa3146-app-a`, `qa3146-app-b`, `mission`, `orbit`, `orbit-lab`, `qa3146-consent-a`, `qa3146-consent-b`, `qa3146-no-capabilities`, **`qa3146-mirror-control` (the negative control)**, `qa3146-source-projection`, `qa3146-unknown-capability` | **QA Expert (authored WITH this suite)** — `.opencode/tests/installable-apps/fixtures/build-capability-fixtures.mjs`, committed by `tests-commit` with the suite | Run `node .opencode/tests/installable-apps/fixtures/build-capability-fixtures.mjs` **on the spec tip** (after any edit to it — a stale output dir would serve documents whose probe plan no longer matches the recorded `probeIds`); record the output dir and the printed table. It **self-checks** every archive (re-parse, CRC, manifest + `capabilities` round-trip, mount export, the exact capability defect for the two refusal fixtures, **each advertised probe id embedded in `main.js`, the rendered-mirror hooks present, the mirror control's probe knowingly false**) and exits non-zero on failure. It commits **no** hash manifest, so nothing can go stale; **determinism is proven by running it twice and quoting both `sha256` columns**. Read ids / filenames / refusal field paths / per-fixture `probeIds` from the `CAPABILITY-FIXTURES.json` it writes — never from memory. **Every openable fixture is self-driving** (see **Child evidence transport**); none of them needs `execute_js`. |
| 7a | the **child evidence instrument**: a native UIA text read of the `installed-<id>` window + a native window capture | the TESTER's host (no fixture needed) | Used by every row that quotes a `[data-qa3146-*]` line. Captures go to `.opencode/tmp/3146/e2e/` and are uploaded via `upload-evidence`. **One genuine `tauri_webview_*` receipt from a reachable window (`main` / `app-*`) is ALSO mandatory in the verdict** — a native/UIA read is not a live-evidence token for the audit matcher. The missing host-side child read/inject path is a **Toolsmith** item, non-gating. |
| 8 | the consent store at `<FREDO_DATA_DIR>/installed-apps-consent.json` (host-owned, version 1) | product (ST-2) | Written and read by F-7.20/F-7.21/F-7.22/F-7.27; the tester writes it **only** in F-7.27 leg 2 (quoting it before and after). Never edit `manifest.json` or any file in the integrity-pinned install root |
| 9 | the env database's own connection (pg port from the env manifest) | `dev-environment` env manifest (`ports.pg`) | Needed **only** for F-7.11's non-gating corroboration (row count of `feature_mission_monitor_sessions`) via the built-in Database Client. **No live row depends on it** — F-7.18 deliberately does NOT require a data-bearing high-risk success (see its pre-authorized disclosure) |
| 10 | **`packages/fredo-theme/` + the `theme-parity` fixture and its generator entry** (`dist/{index.mjs,index.d.ts,theme.css,tokens.json}`, drift gate, the positive parity app and its three negative variants — one per not-published specifier) | **ST-1** (#3145, named in its Work line) | The fixture renders `[data-testid="authoring-theme-readout"]` and its mirror line carries `mount=`, `surface=`/`text=`/`accent=` as resolved `rgb(…)`, and `token.<name>=` for the four token names. Read token names/values from `dist/tokens.json`, never from memory. **One negative variant per specifier** is what makes F-8.14 drivable — a positive-only fixture leaves that row unsatisfiable |
| 11 | **`packages/fredo-authoring/`** — `dist/index.d.ts`, `schema/fredo-app.schema.json` (generated from the Rust constants), `bin/fredo-app.mjs` (`check`, `pack`) | **ST-2** (#3145) | Invoked as `node <kit>/bin/fredo-app.mjs …` — **never** via a registry install. `check` prints `{code, field?, detail}` per violation on the **22 shipped wire strings** and exits non-zero; with no `--fredo <version>` it must **state which checks it could not perform** |
| 12 | **the repaired fixture corpus** — `qa3147-bad-manifest` with a genuinely-unknown top-level key, `defined` gaining `capabilities`, `package-fixtures.expected.json` regenerated, `README.md` §4 corrected, **plus `qa3145-missing-field`** (a manifest with `displayName` absent) | **ST-2** | F-8.17 (both directions) + F-8.21(c). `qa3145-missing-field` is a scope addition flagged in the #3145 triage `## Discussion` — it must be in ST-2's Work line or it is owned nowhere (G-409) |
| 13 | **`docs/authoring-applications.md` + `.opencode/tests/installable-apps/authoring-claims.md`** (claim → satisfied-by → REQ) | **ST-5** (#3145) | The allowlist is a **durable committed artefact** and is F-8.13's record — never a scratch note. One row per fact; `satisfied-by` cites a `file:line` or a named mechanism |
| 14 | **`.opencode/tests/installable-apps/authoring-exam.mjs`** + the scratch root `.opencode/tmp/3145/external-author/{kit,work,out}/` | **ST-6** (#3145) | Runner contract (first-greenable): `EXAM <ID> PASS\|FAIL <detail>` per check, then `EXAM SUMMARY checks=<n> failed=<n> verdict=<PASS\|FAIL>`, exit **0 iff** verdict PASS. Check ids: `INPUTS`, `DOCUMENTED-PATH`, `SPECIFIERS`, `CHECK-CLEAN`, `DETERMINISM`, `NO-NODE-MODULES`, `SELF-CHECK` (refuses to run when any input escapes the two roots). The **tester** copies the kit before dispatch (key-holder act) |
| 15 | the shipped presets `light-default` + `dark` and a **non-default** accent | shipped (`select[aria-label="Theme presets"]`, `input[aria-label="Primary color"]`, `app/types/theme.ts:238,257,…`) | Derive both accent values from `app/types/theme.ts`; never present a hardcoded hex without naming the preset it came from |

## Non-functional checks

Security (N-1, F-2.2, F-2.5, F-2.6) · Integrity (N-2, F-4.4, F-4.5) · Performance (N-3, F-5.5) ·
Failure containment (N-4, F-4.1…F-4.6) · Theming (N-5, F-1.4…F-1.8) · Build hygiene (N-6) ·
Accessibility (N-7, F-5.2, F-4.1) ·
**#3146 authority NFRs: fail-safe default (F-7.26) · complete mediation (F-7.27) · least privilege
(F-7.4, F-7.10, F-2.5) · diagnosability (F-7.28, F-7.15).** These four are NFRs with a named row
each; none is satisfied by the group passing as a whole.

> **NO OS SANDBOX — do not row a sandbox claim.** #3146's boundary is **authority** (which actions,
> which data), not filesystem or network confinement. The installed document keeps a reachable IPC
> transport (`connect-src ipc: http://ipc.localhost`, N-1) and only the ACL plus the dispatcher decide
> what it reaches. A row asserting process/filesystem/network isolation would be testing something
> the ACs never claim and this slice does not build.

**E-SPAN is a NAMED BLOCKER on every live row**: this feature runs no OTLP producer of its own, so a
missing PostgreSQL port is recorded once, up front, and never retried per row.
