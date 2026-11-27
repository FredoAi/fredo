# installable-apps — Smoke Tests

App-boots + core-path sanity for the installed-application surface. Run in the isolated DEV instance
on the spec tip, after `pnpm install --frozen-lockfile` if the spec added a UI dependency.

## Prerequisites

- `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3147 -EnvId <id> -EnvSlot <n> -RequireIsolation` reports ready (never `Restart`, G-328). **For a #3145 run, substitute `-Spec 3145` and capture to `.opencode/tmp/3145/e2e/`.**
- `tauri_driver_session start` connected at the env's MCP port (a decimal-string `appIdentifier`).
- Screenshot dir exists: `.opencode/tmp/3147/e2e/`.
- Both fixture generators have been run once and their output dirs recorded.
- A fresh isolated boot can take 3–5 min before first paint (G-386) — wait it out; do not call it a wedge.

## Cases

- [ ] **S-1 — App window renders.** `tauri_webview_dom_snapshot(type="structure")` on `main` returns a non-empty `<body>` (child element count > 0).
- [ ] **S-2 — No console errors.** `tauri_read_logs(source="console", lines=50)` before and after the core path shows no `Error:`, `Uncaught`, `Maximum update depth exceeded`, `Content Security Policy`, or `Refused to execute` entry. Check it TWICE — on first paint and after the open/close cycle.
- [ ] **S-3 — The feature surface is reachable.** Settings opens with `[data-testid="settings-nav-installed-apps"]` present; clicking it renders `[data-testid="installed-apps-pane"]` containing `[data-testid="installed-apps-install-button"]` with accessible name **"Install application package..."**.
- [ ] **S-4 — The launcher section is reachable.** Opening the launcher (Ctrl+Space) reveals `[data-testid="launcher-installed-apps-section"]`; with zero installed apps it renders an empty/absent state without throwing (record which), and after an install it lists one `[data-testid="launcher-installed-app"]` per installed app.
- [ ] **S-5 — The core path in one pass.** Install the valid package → the entry appears → open it → a window labelled `installed-<id>` exists with `[data-testid="installed-app-root"]` rendered → close it → the window is gone → re-open it → it renders again.
  - EXPECT: every step observed; no host restart; console clean; the host PID is unchanged across the cycle.
- [ ] **S-6 — No `installed-*` window at startup.** On a fresh boot with at least one installed app present, `tauri_manage_window action="list"` shows NO label starting `installed-` and the host log carries no `fredoapp` serve line before the first open (R-5.1's discriminator, smoke level — the full row is F-5.1). **Read the serve log per the Serve-line receipt in `functional.md`:** grep `<env-root>/logs/dev-env-stdout.log` for `fredoapp`, current boot only (primary, documented at `dev-environment` SKILL.md:234); `tauri_read_logs(source="system", …)` only if that source exists in this driver — optional, never required. **A zero line count only counts as evidence if the same log demonstrably carries a line AFTER the first open** (that is what makes the instrument real); if no instrument yields a line even after an open, record an **ARTIFACT defect** to report — never a silent PASS.
- [ ] **S-7 — Capture captured.** `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3146/e2e/smoke.jpeg")` succeeds and shows the rendered shell (not a blank/white webview); a **native capture** of the child window (`installed-<id>`, via `PrintWindow` / OS screenshot — **not** `tauri_webview_screenshot(windowId="installed-<id>")`, which times out) shows the app's own interface **and its `QA3146-FIXTURE` header line**.
- [ ] **S-8 — Both build gates green.** `pnpm --filter @fredo/ui build` ⇒ `EXITCODE=0`; `cargo check --locked` (from `apps/tauri/src-tauri`) ⇒ `EXITCODE=0` with zero `warning:` lines. Use `run-exitcode.ps1 -Command "<cmd>"` to capture the exit code in this sandbox.
- [ ] **S-9 — The pane's two empty/loaded states.** With zero installed apps, `[data-testid="installed-apps-empty"]` renders and `[data-testid="installed-apps-list"]` is absent; after installing one app the list renders and the empty state is gone (F-6.3's smoke-level leg).
- [ ] **S-10 — The authoring kit boots from a bare directory (#3145).** From a directory containing nothing but the copied kit (no `node_modules`, no checkout): `node <kit>/fredo-authoring/bin/fredo-app.mjs --help` ⇒ exit `0` and lists **exactly** `check` and `pack`; `node <kit>/fredo-authoring/bin/fredo-app.mjs check <a valid package dir> --json` ⇒ exit `0` with `violations: []`; and the theme package's **committed drift-gate command**, quoted verbatim from `packages/fredo-theme/package.json`'s `scripts` entry (do not invent a flag) ⇒ exit `0`.
  - EXPECT: all three exit `0` from the bare directory; no `pnpm`/`npm`/`cargo` invocation anywhere in the sequence; the `--help` verb list is exactly two. Use `run-exitcode.ps1 -Command "<cmd>"` for each `EXITCODE=`.
  - EDGE: a kit that needs `node_modules`, a registry install, or the repo root on the resolution path is a FAIL of NFR-3 — record the exact failing import. A third verb in `--help` means a scaffolder shipped (a named non-goal, and it voids the exam's F-8.1 discrimination — report it, do not accept it).

## Expected outcome

S-1..S-10 all PASS on the spec tip. A capability-denied error on a `main`/`terminal`/`doom`/`app-*`
window is a regression (see `regression.md` R-2) — do not dismiss it as an environment wedge until
the G-046/G-067 ladder has been tried and disclosed.

A failing S-5 blocks the whole round: the remaining functional rows need a working install → open →
close → re-open cycle. Record the failing step and the console/log evidence, and mark the dependent
rows `UNVERIFIED (blocked by S-5)` rather than driving them against a broken cycle.

---

## #3144 cases (the lifecycle / management surface)

- [ ] **S-11.1 — the pane renders the three states as words.** On the 5-app boot (A1 `working`,
  A2 `failing` via `qa3144-damaged-record`, A3 `disabled`, A4 `working`+grant, A5 `working`), open
  Settings → Installed applications.
  - EXPECT: five `[data-testid="installed-apps-entry"]` rows; A1/A4/A5 show `Working`, A2 shows
    `Failing`, A3 shows `Turned off`; each row carries a matching `data-app-state`. No console error.
  - EDGE: a blank pane with a damaged app present is the pre-change abort — report it as the smoke-level
    discrimination for `F-9.1`; do not call it an env wedge.

- [ ] **S-11.2 — turn off → turn on round-trip, no restart, console clean.** Click
  `[data-testid="installed-apps-disable"]` on A1; confirm the row reads `Turned off`; click
  `[data-testid="installed-apps-enable"]`; confirm it reads `Working`.
  - EXPECT: both transitions observed without a host restart (PID unchanged); the launcher section
    drops A1 while off and offers it again when on; `tauri_read_logs(source="console", lines=50)` shows
    no `Error:`/`Uncaught` after the cycle.
  - EDGE: enabling a `failing` app must read `Failing`, not `Working`.

- [ ] **S-11.3 — remove → disclosure → confirm → gone.** Click `[data-testid="installed-apps-remove"]`
  on A4.
  - EXPECT: `[data-testid="installed-apps-remove-dialog"]` with `installed-apps-remove-disclosure`
  renders **before** any confirm and states the data is kept; after
  `[data-testid="installed-apps-remove-confirm"]` the row is gone from the pane and the launcher and
  `installed_app_open{appId:"qa3146-consent-a"}` is refused with no window.
  - EDGE: `installed-apps-remove-cancel` leaves everything unchanged.

- [ ] **S-11.4 — both build gates green.** `pnpm --filter @fredo/ui build` ⇒ `EXITCODE=0`;
  `cargo check --locked` (from `apps/tauri/src-tauri`) ⇒ `EXITCODE=0` with zero `warning:` lines.
  Use `run-exitcode.ps1 -Command "<cmd>"`.

- [ ] **S-11.5 — a damaged record does not blank the pane (smoke-level of F-9.1).** With the
  `qa3144-damaged-record` fixture applied to A2, open the pane.
  - EXPECT: the other four entry rows still render and A2's row reads `Failing`.
  - EDGE: if the pane shows `installed-apps-list` absent / a `list-load-failed` state, that is the
    pre-change behaviour (the listing abort) and it **fails the smoke leg** — record it and route it to
    `F-9.1`, never a silent skip.

## Expected outcome (#3144)

S-11.1…S-11.5 all PASS on the spec tip, in addition to the parent S-1…S-10. A failing S-11.3 blocks the
AC-3 group; a failing S-11.5 blocks the AC-1/AC-5 group (`F-9.1`) — record the failing step and mark
the dependent rows `UNVERIFIED (blocked by S-11.x)` rather than driving them against a broken state.

---

## #3241 cases (development mode — the cheapest boot check for the dev-load path)

> **Policy: `live`** (the parent file's). These are the cheapest boot-level checks for the
> development-load path; the graded rows are `functional.md`'s `F-10.1` … `F-10.11`. Nothing here
> substitutes for them. The dev leg is an **existing archive installed through
> `installed_app_install_development`** — there is no development-package fixture and no mode env var
> (`F-10.10`'s text carries the declared absence).

- [ ] **S-12.1 — the dev-load path runs end to end, once.** From `main`, call
  `installed_app_install_development{archivePath:"<absolute path to qa3147-valid-<v>.zip>"}`; then
  `installed_app_open{appId:"qa3147-valid"}`.
  - EXPECT: the invoke **resolves** with an entry whose `mode` is `development`;
    `tauri_manage_window action="list"` shows `installed-qa3147-valid` with the title
    **`Development — QA3147 Valid`** (the marker **LEADS** — `DEVELOPMENT_TITLE_PREFIX`);
    `<FREDO_DATA_DIR>/installed-apps/qa3147-valid/development.json` exists; a native capture of the
    window shows the marker band at the top edge. No console error.
  - EDGE: a resolve with `mode: "released"` is a total FAIL — the other command was called. A window
    that opens with the app's own UI but **no** band and **no** title marker is the pre-change
    behaviour; record it as the smoke-level discrimination for `F-10.1`/`F-10.2`, not an env wedge. A
    title that carries `Development` as a **suffix** is a FAIL — the constant is a prefix.

- [ ] **S-12.2 — both list surfaces carry the mode on `main`, in one snapshot.** With S-12.1's dev
  build plus one normally-installed app present, open Settings → Installed applications, then the
  launcher.
  - EXPECT: the dev row and the dev entry both carry `data-app-mode="development"` with a `-mode` node
    reading exactly `Development`; the released row and entry both carry `data-app-mode="released"`
    with **no** `-mode` node. **The launcher entry's accessible name carries the mark too**
    (C-1/Architect D-10b — the `aria-label` masks the painted chip): the dev entry's name is
    `<displayName>, development build`, and the released entry's name is the bare `displayName`. Quote
    both names. No console error, no `Maximum update depth exceeded`.
  - EDGE: a missing `data-app-mode` on any row (treated as `released`) reddens `F-10.3`/`F-10.4` —
    the attribute is **always present**; record it rather than reading the absence as released. A dev
    entry whose accessible name is the bare `displayName` is the masked-chip defect `F-10.4` reddens —
    the chip is painted and the mark is never announced.

- [ ] **S-12.3 — the shipped load control is present and named.** On `main`, open the pane and read
  `[data-testid="installed-apps-install-development-button"]`.
  - EXPECT: the button renders, is a real `<button>`, is keyboard-reachable, and its **accessible name
    is exactly `Load development build...`** (text button, never icon-only). Quote the name.
  - EDGE: an icon-only control, or a name that differs from the shipped label, reddens `F-10.10`'s
    static half — quote the actual name, do not paraphrase it into a pass.

- [ ] **S-12.4 — both build gates green.** `pnpm --filter @fredo/ui build` ⇒ `EXITCODE=0`;
  `cargo check --locked` (from `apps/tauri/src-tauri`) ⇒ `EXITCODE=0` with zero `warning:` lines.
  Use `run-exitcode.ps1 -Command "<cmd>"`.

## Expected outcome (#3241)

S-12.1…S-12.4 all PASS on the spec tip, in addition to the parent S-1…S-10 and the #3144 S-11.x set.
A failing S-12.1 blocks the whole `## #3241` functional group — the marking rows all need a working
dev-load path; record the failing step and mark them `UNVERIFIED (blocked by S-12.1)` rather than
driving them against a broken load.
