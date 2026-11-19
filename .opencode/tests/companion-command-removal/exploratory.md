# companion-command-removal — Exploratory

Unscripted edge/failure probes for Issue #3152. Nothing here is a required AC row — these are the
"what-if" sequences the Tester probes beyond the script. **A confirmed finding promotes to
`functional.md` as a new `F-`/`Q-` row** (keep the origin note).

> Verification policy: **live plan, mixed per row** — see `functional.md`'s statement. Env L needs
> the companion GGUF trio present; Env S is `cargo` + PowerShell only.

## The removal's edges

- [ ] **E-1 — does anything still *offer* a generated skill after a surface is published?**
  The registry's writer is gone, so publishing is impossible in product source. Probe: run the full
  nextest suite and grep the run for any test that still constructs a surface manifest outside the
  guard's allowlist. **Prompt:** is there a surviving test *subject* (not an incidental import) that
  still asserts a generated skill exists? If yes, the removal is incomplete and the row promotes.
  Removes the temptation to "keep one test for coverage".

- [ ] **E-2 — a half-landed manifest/permission pair.** If a developer removes a
  `runtime/command_manifest.rs` entry but leaves the `permissions/app/default.toml` grant (or vice
  versa), `build.rs:136-142` generates a permission with no backing command. Probe: build and look
  for a permission-generation warning or an orphan `allow-*` id. **Prompt:** does a stale grant
  produce a *silent* build or a loud one? Record which, and whether the guard would catch it (it
  bans the token, so it should).

- [ ] **E-3 — the guard's allowlist entry becomes live.** Temporarily (in a scratch tree, never
  committed) add a file under `.opencode/tests/companion-command-removal/` naming a banned token and
  widen the guard's root to `.opencode/tests`; confirm the plain run reports `CLEAN (hit(s), all
  covered by the evidence allowlist)` **and** still exits `0`. Then revert the widening. **Prompt:**
  is the allowlist mechanism genuinely exercised, or merely declared? This is the G-431 non-vacuity
  probe.

- [ ] **E-4 — a probe leaking after a self-test failure.** Force a control to fail (e.g. run
  `-SelfTest` from a copy where the seeded-root probe cannot be written) and confirm the
  `try/finally` still removes any probe it created. **Prompt:** does a failed self-test leave a
  probe file behind (check the paths the guard printed)? A leftover probe is a suite defect and
  promotes to a FAIL row.

## The turn path's edges

- [ ] **E-5 — a turn while nothing has ever been published *and* the model is cold.** Boot the
  isolated env, do not open any application, and immediately submit a turn. **Prompt:** does the
  first turn (cold model load) still settle without an error, or does the loading placeholder hang?
  Distinguish a slow-but-settling load from a genuinely stuck one — record the elapsed time.

- [ ] **E-6 — an unknown / ambiguous application name.** Submit `open Narnia` (unknown) and then a
  partial name that matches two apps (ambiguous). **Prompt:** does the unknown reply name the
  unresolved identity verbatim (`I couldn't find "Narnia"`, `appOpenReply.ts:37-39`), and does the
  ambiguous reply use the join rule (`appOpenReply.ts:46-51`, `joinCandidateNames` `:88-95`)? A
  spawned window on either = a promo to a FAIL row.

- [ ] **E-7 — close an app that is not open.** Submit `close Mission Monitor` with no frame present.
  **Prompt:** exactly `Mission Monitor isn't open` (`:80-82`) and zero side effects? A "Closing" claim
  is the honesty failure this shape exists to prevent.

- [ ] **E-8 — the `new-window` presentation branch.** Persist `app_window_presentation =
  {"mission-monitor":"new-window"}` and re-run the open/close legs. **Prompt:** does the open produce
  the native host `app-mission-monitor` instead of the in-webview frame, and does `close_app` close
  it (`closeAppOwnWindow`, `appWindows.ts:46-49`)? This is the **only** leg that makes
  `tauri_manage_window(action="list")` load-bearing — record which host the env produced so no
  tester reports the `same-window` default as a FAIL.

- [ ] **E-9 — mid-turn interference.** Submit a conversational turn, then submit an `open_app` turn
  before the first settles. **Prompt:** the FIFO/interrupt path (`CompanionEntity.tsx:1455-1476`)
  must accept the second send (queue or logical interrupt) and still settle exactly once per
  generation — no double `llm-done`, no error state.

## The evidence path's edges

- [ ] **E-10 — is any span actually emitted?** Query `telemetry_spans` for the companion turn.
  **Prompt:** if the table has no row for this turn (expected — the turn path emits no span of its
  own), record `E-SPAN` verbatim and confirm the live policy rests on the `tauri_webview_*`
  receipts. **Do not** substitute the CLI `fredo emit` path — it writes RTDB rows and zero spans
  (G-256).

- [ ] **E-11 — the isolated env's PG port.** Probe whether the isolated env exposes a PostgreSQL
  port to the tester. **Prompt:** if it does not, `E-SPAN` is pre-authorised; if it does, run a real
  `telemetry_spans` query so the evidence guard has both levers.
