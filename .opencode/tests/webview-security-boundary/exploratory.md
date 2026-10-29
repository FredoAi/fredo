# webview-security-boundary — Exploratory Tests

Unscripted probes for the hardened boundary. A confirmed finding **promotes** to `functional.md`
as a new `F-` row (keep the origin note). Probes are cheap live checks in the DEV instance or a
bundle — no new fixtures.

> Do not probe the admin/GitHub surface; this suite is about the webview runtime only.

## Prompts (seed probes)

- [ ] E-1: **Duplicate / conflicting permission.** Does any capability file grant a shell permission under a variant id (`shell:allow-open` vs `shell:default`, or `mcp-bridge:default` in a third file)? Read every file, not just the two known ones. EXPECT: none — a single grant anywhere re-opens the privilege.
- [ ] E-2: **ACL denial is an ACL error, not a parsing error.** Send a deliberately malformed `plugin:shell|execute` payload (missing `program`) and a well-formed one. EXPECT: both reject; the well-formed case must name the capability/ACL, proving the grant is absent rather than the args being wrong.
- [ ] E-3: **XSS-shaped inline script.** In DEV, `execute_js` a document that appends an inline `<script>` that sets `window.__xss=1`. EXPECT: in PROD-POLICY the inline script does not execute and a CSP `Refused to execute inline script` violation is logged; in DEV it does execute (`devCsp`, expected). If the production policy silently allows it, the hardening is ineffective.
- [ ] E-4: **Global handle absent in a production-policy build.** `typeof window.__TAURI__`, `typeof window.__TAURI_INTERNALS__` in the `--debug` bundle and in the release exe (via a native channel if available). EXPECT: `__TAURI__` undefined; `__TAURI_INTERNALS__` present (unconditional injection) → product IPC still works.
- [ ] E-5: **Dev override leak.** Does `pnpm --filter @fredo/tauri build` (release) pick up `tauri.dev.conf.json` in any way (a `--config` in the script, an env var, a stale `TAURI_CONFIG`)? EXPECT: no; `__TAURI__` absent in the release exe / `--debug` bundle.
- [ ] E-6: **Bridge port replay after a crash.** Kill only the DEV app (leave Vite), then relaunch `Up`. EXPECT: the bridge rebinds its recorded port (or scans and logs the new one) and the driver can attach; a killed bridge must not leave `get_pty_buffer`/`execute_js` silently dead without a log line.
- [ ] E-7: **Multiple windows, one probe each.** Run the shell-denial probe from `main`, `terminal`, `doom`, and an `app-*` window. EXPECT: denied on all four (a per-window capability scoping bug would let one window through).
- [ ] E-8: **HMR-free production policy.** In the `--debug` bundle, does any Vite/dev-only script or `@vite/client` reference remain (which would need inline script)? EXPECT: none — a prod-policy build must not depend on the dev CSP.
- [ ] E-9: **Screenshot/native channel degradation.** After the F-12 `execute_js` probe (which destroys the bridge result channel), confirm `tauri_manage_window action="list"` and a host/native screenshot still work. EXPECT: window enumeration works; document the exact tool that degrades so a later tester does not report a product defect.
- [ ] E-10: **External link double activation.** Click a link twice quickly. EXPECT: no queued second window, no duplicate shell probe, console clean (baseline parity).

_Confirmed probes promote to `functional.md`; a probe blocked by a sandbox/tooling limit is recorded `UNVERIFIED` with a named blocker — never a PASS._

---

# #3078 probes — seam-hardening edges (verification policy: **static**)

These are headless probes against the pure rules and headless fixtures (no running app, no MCP
drive). A confirmed FINDING promotes to `functional.md`; a probe whose expectation the plan does
not pin is recorded with the observed behaviour and reported to the QA Expert at convergence — it
is not a FAIL on its own.

- [ ] **E-11 — whitespace class of a sensitive value.** Probe `"\t\n "`, `"\u{00A0}"` (NBSP),
  `"\u{200B}"` (zero-width space) through `validate_setting_value`.
  - EXPECT: `"\t\n "` and NBSP clear (`trim().is_empty()`), `"\u{200B}"` is NOT whitespace and NOT a
    control char (< U+0020 / = U+007F) and is not absolute ⇒ `… path must be absolute`. Record the
    three outcomes.
  - WHY: the "empty (or whitespace-only) clears" reading must not silently widen to
    "invisible-but-non-empty clears".

- [ ] **E-12 — a pasted path with a stray space.** `" C:\x\copilot.exe"` and
  `"C:\x\copilot.exe "` through the settings rule.
  - EXPECT: both rejected `path must be absolute` (a leading/trailing space makes the path
    non-absolute on Windows). Record the UX consequence: a user who pastes a path with a trailing
    space now gets a rejection instead of a silently-wonky stored value — this is the intended
    strictness, not a bug, but it should be surfaced in the error if the UI ever shows it.

- [ ] **E-13 — Windows prefix forms, both rules.** `\\?\C:\x\a.exe`, `\\.\C:\x\a.exe`,
  `\\server\share\a.exe`, `C:foo\a.exe`, `\foo\a.exe`, through (a) `validate_setting_value` and
  (b) `resolve_cli_export_target`.
  - EXPECT: record each outcome. Anticipated — settings: extended/verbatim and UNC forms are
    `is_absolute()` on Windows ⇒ ACCEPTED; `C:foo` and `\foo` ⇒ rejected "must be absolute". Export:
    the first three ⇒ `EXPORT_ABSOLUTE_REFUSED` or `EXPORT_PREFIX_REFUSED` (record which), `C:foo` ⇒
    `EXPORT_PREFIX_REFUSED`, `\foo` ⇒ record (it has a root but no prefix).
  - WHY: this is the shape of the unpinned export check order surfaced in the plan's Discussion. A
    form the plan does not classify is reported, not failed.

- [ ] **E-14 — odd but legal relative `out` values.** `out` = `"."`, `".\x.jsonl"`, `"a//b.jsonl"`,
  `"CON"`, `"nul.jsonl"`, `"x."`, `"%TEMP%\x.jsonl"`, `"$env:TEMP\x.jsonl"`.
  - EXPECT: none contains `..` and none is absolute ⇒ all `Ok`, resolved under `<dir>/exports/` with
    no environment-variable expansion (`%TEMP%` / `$env:` stay literal path segments). Record each
    resulting path; a Windows device name (`CON`) may still fail at the write with an IO error —
    record the typed `requestFailed`, not a confinement bypass.

- [ ] **E-15 — junction/symlink inside `exports/` (KNOWN RESIDUAL).** Read
  `resolve_cli_export_target`'s implementation, then create a junction with
  `New-Item -ItemType Junction -Path .opencode/tmp/3078/qa/dataset/exports/escape -Target C:\Windows\Temp`
  (user-level, no admin).
  - EXPECT: the rule is purely component-based — `Path::components()` / `Component::ParentDir` only,
    **no** `canonicalize` / `fs::metadata` / symlink resolution — therefore a pre-existing junction
    inside `exports/` is NOT closed by this spec. Record "known residual confirmed
    (source-level)", **not** a FAIL.
  - WHY: the plan records this residual explicitly so a later reader does not mistake it for a
    missed gap or try to "fix" it inside this scope.

- [ ] **E-16 — unwritable export target.** Headless form (no app, no env mutation): call
  `export_dataset(&writer, fmt, Some(<target>))` with the target set to (a) an existing DIRECTORY
  (`.opencode/tmp/3078/qa/export`) and (b) an unwritable path
  (`C:\Windows\System32\fredo-3078.jsonl`). The env-seam wire-up itself is a pure read already
  covered by F-29/F-30.
  - EXPECT: typed `requestFailed` (`dataset export failed: …`), NO partial/temp file left at either
    target, and the seeded source dataset byte-identical afterwards. Record the exact message shape.
  - WHY: G-300 — an error-path edge needs an induction lever; the explicit pre-resolved target IS
    the lever and no elevated permission is needed for the directory case.

- [ ] **E-17 — cancel flag value domain.** `FREDO_DOOM_EXPORT_CANCEL` = `"1"`, `" 1 "`, `"01"`,
  `"true"`, `"0"`, `""`.
  - EXPECT: `"1"` and `" 1 "` cancel (trimmed `"1"`); `"01"`, `"true"`, `"0"`, `""` do NOT cancel
    (the path seam / dialog route is taken instead). Record all six outcomes against
    `export_seam_outcome`.

_Confirmed probes promote to `functional.md`; a probe blocked by a sandbox/tooling limit is recorded
`UNVERIFIED` with a named blocker — never a PASS._

