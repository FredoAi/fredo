# Decision Comment Template

> Used by the **Self-Improver** to post decisions on the **feature issue** via the `comment` action (`--prefix Decision`). Draft this file as `.opencode/tmp/<issue>/decision.md`, then run:
> `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent self-improver --action comment --prefix Decision [--body-file .opencode/tmp/<issue>/decision.md]`
> The state machine prefixes `## Decision` automatically and posts it.

<!-- The Decision comment carries the exit-guard markers the triage/audit gates check. -->

## Triage convergence

<!-- For the triage → implementation transition: the body MUST contain "Triage converged"
     (the triage exit gate checks it). State what the cluster agreed. -->

Triage converged — all planner questions resolved.

- <summary of the converged plan: scope, decomposition, staffing, risks>

---

## Audit verdict

<!-- For audit-record: `audit-record` posts its own Decision; this template is for a
     standalone audit Decision if posted via `comment`. -->

Audit verdict: **success** (or **restart → <phase>**).

- <record-anchored judgment: evidence, verification_ok, spec PR merged, telemetry tail>

*Authored by Self-Improver*
