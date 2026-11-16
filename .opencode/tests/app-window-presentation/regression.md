# Regression — app-window-presentation

> Feature #2955 generalizes the #2947 Terminal presentation contract to every app. These are the
> "must not change" baselines to re-run on every testing phase that touches the app-window surface.
>
> Overlapping prior suites to inherit from: `.opencode/tests/terminal-presentation-mode/` (the
> Terminal contract this generalizes), `.opencode/tests/window-manager/` (in-window kernel
> lifecycle), `.opencode/tests/launcher/` (grid + Open-apps row), `.opencode/tests/settings/`
> (Settings shell), `.opencode/tests/terminal/` (session/PTY lifecycle), `.opencode/tests/doom-mode/`.

## Invariants

- [ ] **R-1 — Terminal's shipped capability set is unchanged.** In both modes Terminal keeps multi-session sidebar, add/close, rename, previous-sessions/resume, plain-shell sessions, session-type + working-directory defaults, and output streaming. `open_terminal_window` / `close_terminal_window` / `spawn_terminal_session` command names and the `terminal_presentation_mode` legacy read are intact.
- [ ] **R-2 — Terminal window close tree-kills every session (no orphans).** Close the native `terminal` window with a live session; `process-hygiene.ps1 -List` shows no surviving PID from the session tree.
- [ ] **R-3 — Doom mode unchanged.** Doom opens in its singleton `doom` native window with the shipped `doom_close_handler` engine teardown; no new event vocabulary.
- [ ] **R-4 — In-window kernel lifecycle unchanged.** Opening/closing/minimizing/restoring/focusing an in-window app behaves as before (window store singleton by id, epoch-based updates); `reopenHydratedSlots` (tiled-workspace restore) STILL opens in-window and is NOT routed through the presentation branch.
- [ ] **R-5 — Factory (`isMultiWindow`) apps unchanged.** Query Viewer still spawns independent instances in-window; `getAppPresentation` returns `same-window` defensively for it; no per-app singleton native window is created for a factory app.
- [ ] **R-6 — No cross-feature imports; token-first colors; Chakra v3.** The Apps section imports only shared modules; no hardcoded hex/rgba and no alpha-append onto `var()`; Chakra v3 props only (`disabled` not `isDisabled`, `colorPalette` not `colorScheme`).
- [ ] **R-7 — `fredo open-terminal` validation + exit codes unchanged.** no flags → `opened` (0); `--cli shell` → `started` (0); `--cli bogus` → `invalid-cli` (1); `--cli ""` → `invalid-argument` (1); `--dir <missing>` → `invalid-directory` (1); app stopped → exit 2.
- [ ] **R-8 — `close_app` honesty.** `closeAppOwnWindow` returns true only when a native window existed; an in-window app is still closed by the in-window path; no false "not open" for a `new-window` app.

## CI-parity baseline

- [ ] **R-9 — full local CI command set green** (`CONTRIBUTING.md`):
  `pnpm --filter @fredo/ui typecheck`, `pnpm --filter @fredo/ui build`,
  `pnpm --filter @fredo/ui test:run`, `cargo check --locked`, `cargo test --locked`,
  `cargo clippy --locked -- -D warnings`.
  **Expected:** all exit 0 with zero warnings.
