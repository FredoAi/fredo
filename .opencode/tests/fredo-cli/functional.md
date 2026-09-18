# Fredo CLI — Functional

> Durable functional suite for the `fredo` CLI binary — the `apps/tauri/src-tauri/src/infrastructure/cli/`
> + IPC surface that forwards commands to the running desktop app (today `emit`, `setup`).
> Seeded at Spec #2893 for the open-app command (R-2): the CLI can open a Fredo app/feature by
> identity against the running app, returning a success/failure outcome, and keeps the documented
> not-running fallback.
> Conventions: one `- [ ]` case per requirement, ID prefix `F-`; observable expected outcomes only.
> On pass keep the checkbox and append evidence; on fail leave `- [ ]` and mark `FAIL` with
> expected-vs-actual + repro.
> **Verification policy: live** — every row runs the shipped binary and quotes its literal
> stdout/stderr + exit code against the running app (`docs/CLI_GUIDE.md`).
> Map 1:1 to the QA Plan `R-2` (the Architect's EARS id for AC-2; CLI rows).
> **Prerequisites:** the `fredo` binary on PATH; the app running for F-1/F-2/F-3/F-5; the app DOWN for
> F-4. The bound command is `fredo open-app <IDENTITY>` (one positional; exit 0/1/2; help-listed).

## F-1 (R-2) — `fredo --help` lists the open command

- [ ] F-1: Run `fredo --help` and `fredo open-app --help`; record stdout + exit code.
  **Expected:** the literal `open-app` subcommand appears in `fredo --help`; its help names the
      identity argument and shows the id/display-name forms; both invocations exit 0; the existing
      `emit`/`setup` commands remain listed.
  - **Edge:** an unknown flag → non-zero + usage; `fredo help open-app`; no argument → GUI-mode
    behavior unchanged.

## F-2 (R-2) — Open by identity against the running app

- [ ] F-2: With the app running, run `fredo open-app mission-monitor`; repeat with
      `fredo open-app "Mission Monitor"` and a case variant; record stdout/stderr + exit code and
      the window list.
  **Expected:** the target window opens and its identity fingerprint (aria-label + header title) is
      byte-equal to the surface the Mission Monitor TILE opens; the command returns a success outcome
      (exit 0) and prints a machine-readable result; no further action needed.
  - **Edge:** re-invoke focuses the SAME window (no duplicate); surrounding whitespace; id vs display
    name; the CLI open path reuses the same kernel opener as the launcher (no second opener).

## F-3 (R-2) — Unknown identity fails readably with a non-zero exit

- [ ] F-3: Run `fredo open-app not-a-real-app`; record stderr + exit code + window count.
  **Expected:** NON-ZERO exit; a readable message naming the unknown identity; ZERO windows open; the
      running app stays stable (still responsive, no crash).
  - **Edge:** empty identity; an identity matching ≥2 features (ambiguous — record the bound behavior,
    QA-3); a non-showable feature id.

## F-4 (R-2) — App not running → exit code 2 + the documented fallback

- [ ] F-4: With the app DOWN (run before launch, or after an explicit Down), run
      `fredo open-app mission-monitor`; record stdout/stderr + the RAW exit code.
  **Expected:** exit code **2** and the documented fallback message from `docs/CLI_GUIDE.md`
      ("Fredo app is not running. Start it first with `fredo` (no arguments), then retry…"); nothing
      opens; no hang.
  - **Edge:** the same fallback for `fredo emit` (unchanged — R-1); app down at the moment of
    invocation vs killed mid-call.

## F-5 (R-2) — No crash / no duplicate across repeated CLI opens

- [ ] F-5: Run the open command ≥5 times (same and different identities) with the app running;
      record window counts, exit codes, and the console.
  **Expected:** no duplicate windows (re-invokes focus the existing one); exit codes consistent; no
      console `Error:`/`Uncaught`/`Maximum update depth exceeded`; the app remains responsive.
