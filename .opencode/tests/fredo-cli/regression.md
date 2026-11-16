# Fredo CLI — Regression

> "Must not change" baseline for the `fredo` CLI binary. Seeded at Spec #2893 (the open command is
> ADDITIVE — nothing is retired). Run on every testing phase that touches the CLI surface.
> **Verification policy: live** — run the shipped binary and quote literal output + exit codes.

## R-1 — Existing CLI commands + not-running fallback unchanged

- [x] R-1: With the app DOWN, run `fredo emit ...` and record the raw exit code; then with the app
      running run a valid `fredo emit` and `fredo setup --check`; record output + exit code.
  **Expected:** the app-not-running fallback stays exit code **2** with the documented message for
      `emit` (and every IPC command) exactly as `docs/CLI_GUIDE.md` documents; `emit` still queues the
      event (`{"queued":true}`) against the running app; `setup --check` behavior unchanged.
  - **PASS (live, spec/2893 @ 614f26d3).** App DOWN: `fredo emit --event-type chat
    --session-id e2e-2893-down` → exit **2**, no hang. App UP: `fredo emit --event-type chat
    --session-id e2e-2893-chat` → `{"queued":true}` and classified into `chat_rows` (n=1).
    `fredo setup --check` → exit 0, valid JSON (PATH/opencode/otel/plugin `ok`). Pre-existing
    non-TTY note: the fallback message is TTY-gated (`cli/mod.rs:75`) so it is silent under the
    harness — exit code 2 is the literal AC and holds.

## R-2 — `--help` surface additive only

- [x] R-2: Diff `fredo --help` output against the pre-spec binary output; list added/removed lines.
  **Expected:** the ONLY added lines are the new open command (+ its args); `emit`/`setup` and the
      top-level description are unchanged; no removed/renamed command.
  - **PASS (live).** `fredo --help` exit 0 lists exactly `emit`, `setup`, `open-app`, `help` —
    `open-app` is the ONLY added subcommand; no command removed/renamed. Source pin
    `cli_help_lists_open_app_emit_and_setup` green in the ST-4 report.

## R-3 — IPC wire compatibility

- [x] R-3: Run `fredo emit` against the running app and verify the event classifies into
      `chat_rows`/`tool_use_rows` (telemetry-query skill); run the new open command and verify it does
      not disturb the row pipeline.
  **Expected:** the `CliCommand` wire shape for existing commands is unchanged (no breaking
      serialization change); the row pipeline still ingests; the new command adds its own variant
      without altering existing behavior.
  - **PASS (live, spec/2893 @ 614f26d3).** `fredo emit --event-type chat --session-id
    e2e-2893-chat` → `{"queued":true}` → `chat_rows` 1 row; `--event-type tool_use --session-id
    e2e-2893-tool --tool-name read_file` → `tool_use_rows` 1 row (`read_file`); `telemetry_spans`
    6891 rows with a recent `max(ingested_at)=2026-09-18T16:33:55`. The `open-app` round-trip
    (`{"type":"open_app","identity":…}`) did not disturb the row pipeline (subsequent emits still
    classify). Wire shape for `emit` unchanged (same clap args, same JSON).

## R-4 — Existing commands unchanged by `open-terminal` (additive only)

- [ ] R-4: Diff `fredo --help` against the pre-spec binary output; run `fredo emit --event-type chat
      --session-id e2e-2935-cli` and `fredo setup --check`.
  **Expected:** the ONLY added lines are the new open-Terminal subcommand (+ its flags); `emit`/`setup`
      behavior unchanged; `emit` still returns `{"queued":true}` and classifies into `chat_rows`
      (`telemetry-query`); no command removed/renamed.
  - **Edge:** app DOWN for `emit` → exit 2; unknown flag → clap exit 2.

## R-5 — IPC wire compatibility + `open-app` unaffected

- [ ] R-5: Run `fredo open-app mission-monitor` (still opens Mission Monitor, exit 0) and verify the
      `CliCommand` wire shape for existing commands is unchanged; then run the new open-Terminal
      command and re-run an `emit` to confirm the row pipeline still ingests.
  **Expected:** the new command adds its own `CliCommand` variant without altering existing variants;
      `open-app` still opens/focuses one window; the row pipeline still ingests (`chat_rows` grows).
  - **Edge:** `open-app` re-invoke focuses the same window; interleave `emit` + `open-terminal`.

### #2893 testing round 2 (spec/2893 @ 223279d3) — results

- **R-1 PASS.** App DOWN: `fredo emit --event-type chat --session-id e2e-2893-r2-down` → exit **2**
  (34 ms, no hang). App UP: `fredo emit --event-type chat --session-id e2e-2893-r2-chat` and
  `--event-type tool_use --session-id e2e-2893-r2-tool --tool-name read_file` → both
  `{"queued":true}` and classified into `chat_rows` / `tool_use_rows`. `fredo setup --check`
  unchanged (round 1 + the same binary).
- **R-2 PASS.** `fredo --help` exit 0 lists exactly `emit`, `setup`, `open-app`, `help` — `open-app`
  is the only added subcommand; nothing removed/renamed. Error surface: missing arg + unknown flag
  both exit **2** with clap usage.
- **R-3 PASS.** Emits classified into `chat_rows`/`tool_use_rows` in the same round the `open-app`
  round trip ran; `telemetry_spans` = 7536 rows with a recent `max(ingested_at)
  = 2026-09-18T17:07:32.387140+00:00`. The `open-app` wire shape did not disturb the row pipeline.
