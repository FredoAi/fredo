# Fredo CLI — Regression

> "Must not change" baseline for the `fredo` CLI binary. Seeded at Spec #2893 (the open command is
> ADDITIVE — nothing is retired). Run on every testing phase that touches the CLI surface.
> **Verification policy: live** — run the shipped binary and quote literal output + exit codes.

## R-1 — Existing CLI commands + not-running fallback unchanged

- [ ] R-1: With the app DOWN, run `fredo emit ...` and record the raw exit code; then with the app
      running run a valid `fredo emit` and `fredo setup --check`; record output + exit code.
  **Expected:** the app-not-running fallback stays exit code **2** with the documented message for
      `emit` (and every IPC command) exactly as `docs/CLI_GUIDE.md` documents; `emit` still queues the
      event (`{"queued":true}`) against the running app; `setup --check` behavior unchanged.

## R-2 — `--help` surface additive only

- [ ] R-2: Diff `fredo --help` output against the pre-spec binary output; list added/removed lines.
  **Expected:** the ONLY added lines are the new open command (+ its args); `emit`/`setup` and the
      top-level description are unchanged; no removed/renamed command.

## R-3 — IPC wire compatibility

- [ ] R-3: Run `fredo emit` against the running app and verify the event classifies into
      `chat_rows`/`tool_use_rows` (telemetry-query skill); run the new open command and verify it does
      not disturb the row pipeline.
  **Expected:** the `CliCommand` wire shape for existing commands is unchanged (no breaking
      serialization change); the row pipeline still ingests; the new command adds its own variant
      without altering existing behavior.
