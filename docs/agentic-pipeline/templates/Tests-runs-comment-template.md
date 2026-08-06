# Tests Runs Comment Template

> Drafted by the **Tester** as `.opencode/tmp/<issue>/tests-runs.md` (or `evidence.md`), posted by the testing → audit transition (auto) or the `comment --prefix Evidence` action. The verification gate reads `## Tests Runs` / `## Evidence` for the verdict + `telemetry_spans` evidence.

<!-- V1 — verdict line MUST be the first content line: "Verdict: **PASS**" or "Verdict: **FAIL**" -->

Verdict: **PASS** (N/N ACs)

## Per-AC results

| AC | Result | Evidence type | Evidence |
|----|--------|---------------|----------|
| GA-1 | PASS | `live` | `SELECT ... FROM telemetry_spans ...` → row excerpt |
| GA-2 | PASS | `live` | <query output> |
| GA-3 | FAIL | `live` | <query output — none/incorrect> |
| GA-4 | UNVERIFIED | — | <could not run; state why> |

<!-- `live` = real telemetry-query / DOM / screenshot result you produced.
     `static` allowed ONLY if the plan declares `> Verification policy: static`.
     A case you could not run live is UNVERIFIED/FAIL, never PASS. -->

## Test runs

| Run | Prompt/marker | Date | Result |
|-----|---------------|------|--------|
| 1 | `e2e-<rand>` — chat | <date> | LLM span present |
| 2 | tool prompt | <date> | tool span present |
| 3 | subagent prompt | <date> | run_agent span persisted |

## Caveats

- <CI status, env limits, anything not fully proven>

*Authored by Tester*
