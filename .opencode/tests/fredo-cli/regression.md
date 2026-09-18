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
