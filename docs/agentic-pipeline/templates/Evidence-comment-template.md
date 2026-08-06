# Evidence Comment Template

> Used by the **Tester** (and Self-Improver) to post test results on the **plan issue** via the `comment` action (`--prefix Evidence`). Draft this file as `.opencode/tmp/<issue>/evidence.md`, then run:
> `rust-script .opencode/scripts/pipeline-state.rs --issue <plan-N> --agent tester --action comment --prefix Evidence [--body-file .opencode/tmp/<issue>/evidence.md]`
> The state machine prefixes `## Evidence` automatically and posts it.

<!-- V1 — verdict line: MUST be the first content line and start with "Verdict: **PASS**" or "Verdict: **FAIL**" -->
Verdict: **PASS** (N/N ACs)

<!-- For a LIVE-policy plan the state machine and the audit REQUIRES a `telemetry_spans` reference
     (or other live evidence) inside this file — a static-only PASS is rejected fail-closed. -->

### Per-AC results

| AC | Result | Evidence type | Evidence |
|----|--------|---------------|----------|
| GA-1 | PASS | `live` | `SELECT ... FROM telemetry_spans ...` → row excerpt proving the key+value |
| GA-2 | PASS | `live` | <query output> |
| GA-3 | PASS | `live` | <query output> |
| GA-4 | PASS | `live` | <run_agent session span row EXISTS with gen_ai.agent.name> |
| GA-5 | FAIL | `live` | <query output — none/incorrect> |
| GA-6 | UNVERIFIED | — | <not executable; state why> |

<!-- Rules:
  - `live` = a telemetry-query / DOM / screenshot result you actually produced.
  - `static` = allowed ONLY if the plan declares `> Verification policy: static`.
  - A case you could not run live is UNVERIFIED/FAIL, never PASS.
  - Each row references `telemetry_spans` / `telemetry_metrics` / `telemetry_logs`. -->

### Required test data / isolation marker

- Isolation marker used: `<e2e-xxxxxx>`

### Non-functional checks

| Check | Result | Evidence |
|-------|--------|----------|
| <NFR> | PASS/FAIL | <evidence> |

### Caveats

- <anything not fully proven, CI status, env limitations>

*Authored by <Agent Name>*
