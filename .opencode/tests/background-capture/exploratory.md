# background-capture — Exploratory

Unscripted probes for issue **#3193**. A confirmed finding PROMOTES to `functional.md` as a new
`F-` row (keep the origin note). Nothing here is a binding AC row; record observations with the
instrument output that produced them.

## Prompts

- [ ] **E-1 — hostile argv shapes.** What does the app do with `--background` plus a trailing space
  in the arg (`"--background "`), a Unicode look-alike dash, `--BACKGROUND`, two `--background`
  tokens, or `""` as the only argument? Expected by contract: Background ONLY for the exact sole
  token; everything else goes through clap (a parse error, exit 1) or the normal app path. Record
  each observed exit code and whether a window appeared.

- [ ] **E-2 — two environments at once.** Bring up a SECOND env slot and launch one `--background`
  and one foreground. Do the OTLP receivers stay per-env? Does the background instance hold only
  its own postmaster? Record both PIDs, both port owners and both window readings. (Needs a second
  env slot; if one cannot be allocated this round, record the blocker, not a FAIL.)

- [ ] **E-3 — login entry pointing at a path that no longer exists.** Seed a legacy-shaped value
  whose exe path is gone (`-ForeignCommand '"C:\Gone\fredo.exe" ingest'`). Does startup leave it
  alone (expected: Foreign, untouched, no panic, no `reg add`)? Then enable from the pane: does it
  recover to the current form?

- [ ] **E-4 — concurrent toggles.** Click the toggle several times quickly (or invoke
  `ingest_autostart_set` true/false/true) while an OTLP burst arrives. Final registry state must
  match the last intent; no `ERROR:` from the instrument; spans from the burst all persist.

- [ ] **E-5 — `--background` while an instance is already resident.** Launch `--background` a second
  time against a live env. Expected: the probe sends `Ping`, the second process exits, NO window is
  shown (this is the login-launch-after-already-running case), and the resident instance is
  untouched. Confirm no window appeared at any point.

- [ ] **E-6 — quit from a background-started session.** After F-1c's `Open` (and with the env's
  Vite serving, so the page can invoke), quit via `quit_app`. Expected: bounded teardown, no orphan
  postmaster, no leftover listener, and the next login-entry write is unaffected. If the page never
  loaded, stop the process with `launch-background.ps1 -Action Kill -TargetPid <pid>` and record
  that `quit_app` was not drivable in that state.

- [ ] **E-7 — registry value with an odd type.** If you can seed `REG_EXPAND_SZ` or `REG_MULTI_SZ`
  under the same name (out-of-band), what does the product do? Expected: a typed refusal or a
  classification that is not "owned"; never a panic and never a rewrite of a value it did not
  create. (Record how you seeded it — `reg.exe` is granted.)

- [ ] **E-8 — the pane under a very slow registry read.** Freeze/throttle `reg.exe` if a seam
  exists; otherwise reopen the pane repeatedly and watch for a guessed `Off` before the read
  settles. Expected: skeleton, never a guessed value; no console error.

- [ ] **E-9 — Mission Monitor across a tray `Open`.** With rows persisted while hidden (F-1b),
  open `main` and check the session history does not flash `No sessions yet` (the #3192 F-6c
  gate). Record which surface rendered the fixture.

- [ ] **E-10 (#3195) — a capture STATUS read that never answers.** What does the pane do if the
  first `stream_health` invoke neither resolves nor rejects (a hung bridge)? Expected by contract:
  the region stays `aria-busy="true"` with a skeleton and NEVER renders `Capture: Not running`
  (unresolved ≠ stopped). There is no product seam to hang the bridge; if you cannot induce it,
  record the blocker and cite the component pin (`ingestFailure`/`unknown` legs) instead — never
  report a guessed outcome as observed.

- [ ] **E-11 (#3195) — two Settings webviews at once.** Open Settings, then invoke
  `open_app_window { appId: 'settings' }` again (the builder is focus-if-exists). Does the second
  call create a SECOND webview (two panes, two pollers, two `role="status"` regions in the
  document) or focus the existing one? Expected: exactly ONE `app-settings` window and one pane.
  Record the window list and the document-wide live-region count with the observation that the
  STATUS BAR is itself a live region (a count of 2 is not by itself a defect).

- [ ] **E-12 (#3195) — the capture line across a theme switch mid-state.** Put the pane in the
  `not running` state (F-10b's recipe) and toggle light↔dark. Expected: the warning/success tokens
  re-resolve (no literal colour left behind), the word line unchanged, no console error.

## Notes

- Do not invent instruments: if a probe needs a new lever, report it to the QA Expert as a suite
  gap rather than writing an ad-hoc script under `.opencode/tmp/` and citing it as evidence.
- Registry hygiene applies: any probe that seeds a value ends with `registry-entry.ps1 -Restore`.
