# companion-command-removal — Smoke

App-boots + core-path sanity for Issue #3152 (the companion command-surface removal). Smoke runs
first on every testing phase that touches this feature's surface.

Boilerplate adapted from `.opencode/tests/README.md` §Smoke boilerplate. Verification policy:
**MIXED** — S-1/S-2/S-3/S-6 are `live`; S-4/S-5 are `live` with a `static` confirmation; S-7 is
`static`. See `functional.md` for the per-row policy statement and the pre-authorised named
blockers (`E-MODEL`, `E-SPAN`).

> **Env:** `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3152 -EnvId qa3152-a -EnvSlot 1 -RequireIsolation`;
> driver `tauri_driver_session start appIdentifier="16001"`. `Restart` is forbidden for isolated
> envs — recover with `Down` then `Up`.
>
> **No screenshot-upload dependency.** `gh image` / `upload-evidence` was broken (`uploadToken not
> found`) through the whole S1 run. A local capture to `.opencode/tmp/3152/e2e/` is a scratch
> artifact; it is never the required evidence and is never cited as a `user-attachments` URL. The
> live receipt is a `tauri_webview_*` tool result.

- [ ] **S-1: App window renders.** `tauri_webview_dom_snapshot(type="structure")` returns a
  non-empty `<body>`. **Expected:** the DOM snapshot is non-empty and the companion surface renders
  (`.fredo-companion-avatar` present, `CompanionEntity.tsx:1862`).

- [ ] **S-2: No console errors.** `tauri_read_logs(source="console", lines=50)`.
  **Expected:** no `Error:` / `Uncaught` / `Maximum update depth exceeded`. In particular no failed
  module import — a deleted module still referenced by a barrel surface would fail loudly here.

- [ ] **S-3: Feature surface reachable — the companion composer.** **The composer mounts ONLY on the
  `overlay` surface** (`CompanionEntity.tsx:1833`: `surface === 'overlay' && composerOpen`); the home
  **seat** never renders it, so clicking `.fredo-companion-avatar` at the seat fires the shipped joke
  and does **not** open the composer. The shipped pointer path from the seat is the
  **Ctrl+right-click teleport** (`FredoCompanion.tsx:192-215`). Recipe: Ctrl+right-click the
  companion to teleport it into an overlay, wait until
  `[data-testid="fredo-companion-composer"]` reads count **1**, then read that node.
  **Expected:** exactly ONE composer node mounts; its root carries `role="group"` and
  `data-composer-surface` (`CompanionComposer.tsx:224-230`); the input
  `[data-testid="fredo-companion-composer-input"]` is present and focusable. An immediate re-read
  finding 0 composers is a **FALSE FAIL** (teleport/open settle discipline).

- [ ] **S-4: Telemetry Settings accessible (live + static confirmation).** Open Settings → the
  Telemetry pane via the sidebar nav.
  **Expected (live):** the settings surface renders its sections. **Static confirmation:** the
  settings shell `apps/ui/src/applications/settings-app/components/SettingsSurface.tsx` still
  renders the static sections — this slice must not touch the settings shell.

- [ ] **S-5: A screenshot can be captured (scratch only).**
  `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3152/e2e/smoke.jpeg")`.
  **Expected:** the call succeeds and the file exists locally. **The capture is a scratch artifact,
  never the evidence** — do not upload it (see the header). A capture failure is an env problem to
  record, never a spec FAIL.

- [ ] **S-6: The committed absence guard runs clean.** (static, but run it first — a red guard means
  the deletion landing is incomplete.)
  `run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-companion-commands-retired.ps1"`
  → `EXITCODE=0`; then with `-SelfTest` → `EXITCODE=0` and all seven controls PASS. The plain run also
  prints `Ignore filter: N path(s) excluded (git check-ignore)` — gitignored build output is not
  scanned, and an unavailable ignore query exits `2` rather than widening the scan.
  **Edge:** exit `2` (cannot run, e.g. zero files scanned) is NOT a pass; a leftover probe file
  after `-SelfTest` is a FAIL. See `functional.md` Q-1/Q-2.

- [ ] **S-7: The build gates are green.** (static)
  `cargo check` → `EXITCODE=0` with zero `warning:` lines;
  the CI-parity clippy (`.github/workflows/validate.yml:405`, **no `--all-targets`**) → `EXITCODE=0`;
  `cargo nextest run --manifest-path apps/tauri/src-tauri/Cargo.toml --locked` → `EXITCODE=0` with
  0 failed. **Edge:** `--all-targets` is red at base — never report it. See `functional.md`
  Q-16/Q-17/Q-18.

- [ ] **S-8: One conversational turn settles.** With the composer open (S-3), submit a greeting from
  `[data-testid="fredo-companion-composer-submit"]`.
  **Expected:** `[data-testid="fredo-reply-surface"]` shows non-empty text; `.fredo-companion-avatar`
  `data-state` is not `error`; console shows `[companion] llm-done received` once.
  **Edge:** if the companion model files are absent, record `E-MODEL — NAMED BLOCKER: companion
  model files absent` — never FAIL. See `functional.md` Q-11.
