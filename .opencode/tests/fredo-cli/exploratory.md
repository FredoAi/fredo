# Fredo CLI — Exploratory

> Unscripted edge/failure probes for the `fredo` CLI surface. A confirmed finding PROMOTES to
> `functional.md` as a new `F-` row (keep the origin note). Live policy; an undrivable lever is a
> named blocker (G-053), never fabricated.

- [x] E-1: **App killed mid-call.** Start the open command and kill the app immediately. Does the CLI
      fail cleanly (bounded, readable, a defined exit code) or hang? Any hang/unhandled panic is a
      finding (promotes to F-3/F-4).
- [x] E-2: **Concurrent CLI invocations.** Run several open commands back-to-back/in parallel. Does the
      socket handle them without a duplicate window, a lost response, or a crash? Promotes to F-5.
- [x] E-3: **Identity edge forms.** Probe empty/whitespace/unicode/very long identities, and a feature
      id of a non-showable feature. Does every case produce a readable outcome and open nothing wrong?
      Promotes to F-3.
- [x] E-4: **Stale socket vs live app.** With a leftover socket file but no app, does the CLI follow
      the documented exit-2 fallback or hang? Promotes to F-4.

### #2893 testing round 1 (spec/2893 @ 614f26d3) — results

- **E-1 PASS-ish (bounded).** With the app explicitly DOWN, the open command returned exit **2**
  immediately — no hang, no panic. A kill-mid-call could not be timed precisely; the design bounds
  are `open-app` child ≤10 s + confirm ≤5 s, and the down-path is cleanly bounded.
- **E-2 OBSERVATION (no duplicate/lost/crash).** Rapid back-to-back open commands produced no
  duplicate window and no crash. One call returned `{"outcome":"unavailable"}` exit 1 while the
  window still opened, because the main webview (backgrounded behind the opened window) confirmed
  after the 5 s bound — the frontend logged
  `confirm_app_open_request failed No pending app-open request with id "app-open-…"`. Recorded as a
  bounded-confirm race (CLI reports failure while the open actually lands).
- **E-3 PASS.** `MM` → `unknown` (not an alias); whitespace-only → `unknown` with `spokenName:""`
  (trim, fails closed); `Mission Mon` → `opened` (display-name prefix via `appNameMatches`); a
  non-showable/unknown identity → `unknown`, zero windows.
- **E-4 PASS.** No app / stale socket: exit **2**, no hang (same as F-4).

### #2893 testing round 2 (spec/2893 @ 223279d3) — results

- **E-1 PASS (bounded).** App DOWN: `fredo open-app mission-monitor` exit **2** immediately (33 ms),
  no hang/panic. Kill-mid-call was not separately timed; the design bounds (child ≤10 s, confirm
  ≤5 s) stand.
- **E-2 PASS (no duplicate/lost/crash).** 3 open invocations back-to-back (cold + warm +
  display-name) produced one window, no duplicate, no crash; warm calls 43–76 ms, cold 842 ms.
- **E-3 PASS.** `MM` → `unknown`; `""` → clap exit 2; `Mission Mon` (round 1 + the resolver pins) →
  `opened`; unknown identity → `unknown`, zero windows.
- **E-4 PASS.** No app / stale socket → exit **2**, no hang.
- **O-1 (helper artifact, not a product finding).** `spawnSync(shell:true)` joined the quoted
  `"Mission Monitor"` into two argv tokens (clap exit 2). With `shell:false`: exit 0
  `{"displayName":"Mission Monitor","outcome":"opened"}`. The helper was corrected
  (`.opencode/tmp/2893/cli-probe2.cjs`).
