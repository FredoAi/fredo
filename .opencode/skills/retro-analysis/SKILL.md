---
name: retro-analysis
description: Post-spec retrospective analysis recipes for guardrail effectiveness tracking, cross-spec pattern detection, grounded verification, ACE curation lifecycle, and compositional skill building. Load when the Self-Improver performs post-spec improvement generation.
---

# Retro-Analysis — Self-Improvement Recipes

## Overview

This skill provides reusable technical recipes for the Self-Improver agent. The Self-Improver owns policy decisions (what to guard, when to escalate, how to report); this skill owns the execution mechanics (how to compute effectiveness, detect patterns, verify playbook grounding).

**Core framework:** ACE (Agentic Context Engineering) Generation → Reflection → Curation cycle:
1. **Generation**: Propose improvements from the pipeline's event-log data
2. **Reflection**: Verify previous improvements worked (Self-Refine pattern)
3. **Curation**: Prune stale, escalate violated, compose working guardrails (Voyager skill library)

## Data Sources (current pipeline)

All recipes read from the live pipeline, not static artifact files:

- **Per-issue event logs** — `.opencode/state/issues/<issueNumber>.jsonl`, one file per issue, one JSON event per line (the state machine's append-only system of record; see [state-machine.md](../../../docs/agentic-pipeline/state-machine.md#storage-per-issue-jsonl-event-log)). Event fields: `ts`, `event_id`, `event_name`, `actor`, `entity.issueId`, `phase`, `outcome`, `attempt`, `correlation_id`, `attributes`, `message`. `event_name` is one of `state_machine.call`, `state_machine.failure`, `phase.started`, `phase.completed`, `create-issue`, `triage-init`, `assemble-plan`, `tests-commit`, `comment`, `transition`, `block`, `unblock`, `create-worktree`, `remove-worktree`, `generate-work`, `update-plan`, `close-issue`, `upload-evidence`, `audit.verdict`; `outcome` is `success` / `failure` / `blocked` / `unknown`.
- **State-machine metrics** — `rust-script .opencode/scripts/pipeline-state.rs --action metrics --all --json` (pipeline aggregates: `issues`, `events`, `blocked`, `rework`, `by_agent`, `by_phase`) and `--action metrics --issue <N> --json` (per-issue: `agent_calls`, `phase_durations_min`, `rework_loops`, `blocked_count`, `transitions`). `rework` counts `testing -> implementation` transitions only.
- **Health report** — `rust-script .opencode/scripts/pipeline-state.rs --action health` (pipeline integrity, error counts, verdict summaries).
- **Script errors** — `.opencode/state/script-errors.jsonl` (pipeline script failures, auto-logged).
- **Spec issue comments** — the issue timeline (`gh issue view <spec_N> --comments`), where the Triage cluster, Self-Improver, Developer, and Tester post structured `## Review Results`, `## Capsule:`, `## E2E Test Results`, and `## Retro Report` blocks.

The Self-Improver's improvement ledger (guardrail records: `guardrail_id`, `activation_date`, `target_failure`, `effectiveness`) is maintained by the SI itself — recorded as the `message`/reason of `audit.verdict` events and written into the pipeline docs/skills it owns. This ledger replaces the standalone improvement/metrics artifact files this skill previously read.

---

## Recipe 1: Guardrail Effectiveness Computation

Computes whether an Active guardrail reduced its target failure class after activation.

**Data sources:**
- Per-issue event logs (`.opencode/state/issues/*.jsonl`) — guardrail activations are recorded in `audit.verdict` events (the SI's improvement note in `message`); failure recurrence is visible as rework transitions, `blocked` outcomes, and failed verdicts.
- State-machine metrics — `--action metrics --all --json` and `--action health`.

**Algorithm:**

```
For each Active guardrail with guardrail_id:
  1. activation_date = ts of the audit.verdict event that introduced the guardrail (SI improvement note)
  2. target_failure = the failure class the guardrail addresses (from the same note)
  3. Scan per-issue event logs for failure events matching target_failure:
     - rework: transition with message "testing -> implementation"
     - blocked: outcome == "blocked" OR event_name == "block"
     - failed verdict: audit.verdict with outcome "failed" whose message names the failure class
  4. Count matching failure events BEFORE and AFTER activation_date:
     - before_rate = count_before / issues_before
     - after_rate = count_after / issues_after
  5. Classification:
     - after_rate == 0 AND issues_after >= 2          → "Confirmed"
     - after_rate == 0 AND issues_after < 2           → "Pending"
     - after_rate > 0 AND after_rate < before_rate     → "Partial"
     - after_rate >= before_rate                        → "Ineffective"
  6. Write the effectiveness value back to the guardrail's record in the SI improvement ledger
```

**Implementation via bash:**

```powershell
# Collect every event from the per-issue JSONL logs
$events = @()
foreach ($log in Get-ChildItem ".opencode\state\issues\*.jsonl") {
  foreach ($line in Get-Content $log.FullName) {
    if ($line.Trim().StartsWith('{')) { $events += $line | ConvertFrom-Json }
  }
}

# Failure-event classification used by the effectiveness windows:
#   - rework:  event_name -eq "transition" -and message -match "testing -> implementation"
#   - blocked: outcome -eq "blocked" -or event_name -eq "block"
#   - verdict: event_name -eq "audit.verdict" -and outcome -eq "failed"

# Aggregates are also available directly from the state machine:
#   rust-script .opencode/scripts/pipeline-state.rs --action metrics --all --json
#   rust-script .opencode/scripts/pipeline-state.rs --action health
```

---

## Recipe 2: Cross-Spec Pattern Scanner

Detects recurring failure patterns across multiple specs for guardrail promotion.

**Algorithm:**

```
1. Read all per-issue event logs (.opencode/state/issues/*.jsonl)
2. Group issues by failure class, derived from:
   - failed audit.verdict events (restart phase + reason in message) — the SI's classification
   - rework transitions (testing -> implementation) — verification failed
   - outcome: blocked — work stalled
3. For each failure class with >= 2 occurrences:
   - Check if an Active guardrail already exists with matching target_failure
   - If NO: flag as "unguarded pattern" → candidate for new guardrail
   - If YES: flag as "guarded pattern" → use Recipe 1 to check effectiveness
4. For "unguarded patterns" with >= 3 occurrences:
   - Priority: P0 (recurring, unguarded)
   - Extract the failing spec numbers and the common theme from their verdict/rework messages
   - Propose guardrail text from the common theme
```

**Output format:**

```
| target_failure | Spec Count | Guarded? | Guardrail | Priority |
|----------------|------------|----------|-----------|----------|
| cross_capsule_conflict | 4 | Yes | G-002 | P0 (verify) |
| no_upfront_research | 3 | Yes | G-001 | P0 (verify) |
| scope_violation | 1 | No | — | P2 (monitor) |
```

---

## Recipe 3: Grounded Verification (SituatedThinker Pattern)

Checks whether a guardrail actually exists in the relevant agent playbook, or is only recorded in the SI's improvement ledger (orphaned — never baked into a playbook or a deterministic check). Agent `.md` files are minimal (identity + state-call) — guardrails live in the PLAYBOOKS (`docs/agentic-pipeline/playbooks/<agent>.md`), so the check targets those, not the agent prompt files.

**Algorithm:**

```
For each Active guardrail:
  1. Determine target agent from change description:
     - "Architect must ..." → read docs/agentic-pipeline/playbooks/software-architect.md
     - "Self-Improver must ..." → read docs/agentic-pipeline/playbooks/self-improver.md
     - "Developer must ..." → read docs/agentic-pipeline/playbooks/developer.md
     - "Tester must ..." → read docs/agentic-pipeline/playbooks/tester.md
     - "Pipeline" → read the relevant .opencode/scripts/* (pipeline-state.rs and friends)
  2. Search for the guardrail's key rule in the target playbook:
     - Via grep for distinctive phrases (e.g., "exclusive file ownership", "pre-commit contract")
  3. Classify:
     - "Baked in": Rule text found verbatim in the agent's playbook → no action needed
     - "Absent": Rule NOT in the playbook → guardrail is orphaned, needs playbook update
     - "Ignored": Rule IS in the playbook but failure recurred → guardrail needs escalation to hook
  4. For "Ignored": Check if the violated spec's issue comments / verdict messages mention the rule
     - If mentioned AND still violated → agent saw the rule but ignored it → needs enforcement
     - If NOT mentioned → agent didn't see the rule → playbook placement issue (too deep, buried)
```

**Implementation via bash:**

```powershell
$guardrailRule = "exclusive file ownership"  # extract from guardrail change text
$targetPlaybook = "docs/agentic-pipeline/playbooks/software-architect.md"
$found = Select-String -Path $targetPlaybook -Pattern $guardrailRule -SimpleMatch -Quiet
if (-not $found) {
  Write-Output "GUARDRAIL ORPHANED: '$guardrailRule' not found in $targetPlaybook"
  Write-Output "→ Add rule to the playbook to close the grounded verification gap"
}
```

---

## Recipe 4: ACE Curation Decision Tree

The full Generation → Reflection → **Curation** lifecycle from ACE (Zhang et al., ICLR 2026).

**Decision tree:**

```
For each Active guardrail:
│
├─ EFFECTIVENESS = "Confirmed" (0 occurrences since activation)
│  ├─ Rule is "Baked in" to the agent's playbook?
│  │  ├─ YES → PROPOSE ARCHIVE (guardrail baked into playbook, no longer needs Active tracking)
│  │  │        Archive justification: "Baked into playbooks/<agent>.md line <N>. No occurrences in <M> specs."
│  │  └─ NO  → KEEP ACTIVE (guardrail works but not yet in playbook — add to playbook first, then re-evaluate)
│  │
├─ EFFECTIVENESS = "Partial" (reduced but not eliminated)
│  └─ KEEP ACTIVE, update change text to be more specific (strengthen rule)
│
├─ EFFECTIVENESS = "Pending" (< 2 specs since activation)
│  └─ KEEP ACTIVE (not enough data to evaluate — wait for more specs)
│
├─ EFFECTIVENESS = "Ineffective" (same rate or worse)
│  ├─ Rule is "Ignored" (in playbook but violated)?
│  │  ├─ YES → ESCALATE TO HOOK (playbook-level rule not sufficient)
│  │  │        Escalation report: "Guardrail G-XXX violated in spec #N despite being in playbooks/<agent>.md.
│  │  │        Recommendation: implement as a deterministic check in <script>/<CI step>."
│  │  └─ NO  → STRENGTHEN RULE (add negative examples, move to earlier step, add verifier)
│
└─ STALENESS CHECK (not triggered in 10+ specs)
   └─ PROPOSE ARCHIVE (failure class extinct or pipeline changed)
```

**Compositional skill detection (Voyager/Odyssey):**

When 3+ guardrails share the same `target_failure` AND are all "Confirmed":
→ Propose them as a **Compositional Skill** in the SI improvement ledger (the pipeline doc/skill the SI maintains — the same place guardrail records live):
```
### CS-001: Cross-Capsule Conflict Prevention
composed_from: [G-002, G-003, G-006]
effectiveness: 0 occurrences in last 5 specs
```

---

## Recipe 5: Pipeline Event-Log Data Extraction

Standardized extraction patterns for the 3 Self-Improver data sources. These are **pipeline state-machine event logs + metrics** — NOT fredo.db product telemetry. The SI never queries `fredo.db` (telemetry/observability is the Software Architect's scope).

**Source 1: per-issue event logs + state-machine metrics**

```powershell
# Raw per-issue events (source of truth)
$events = @()
foreach ($log in Get-ChildItem ".opencode\state\issues\*.jsonl") {
  foreach ($line in Get-Content $log.FullName) {
    if ($line.Trim().StartsWith('{')) { $events += $line | ConvertFrom-Json }
  }
}
# Filter by issue: $events | Where-Object { $_.entity.issueId -eq "N" }
# Group by event_name: $events | Group-Object event_name | Select-Object Count, Name

# Derived metrics are computed by the state machine:
#   rust-script .opencode/scripts/pipeline-state.rs --action metrics --all --json
#   rust-script .opencode/scripts/pipeline-state.rs --action metrics --issue <N> --json
#   rust-script .opencode/scripts/pipeline-state.rs --action health
```

**Source 2: script-errors.jsonl — pipeline failures**

```powershell
$errors = Get-Content ".opencode/state/script-errors.jsonl" | ForEach-Object {
  $_ | ConvertFrom-Json
}
# Filter by issue number: $errors | Where-Object { $_.issue -eq "N" }
# Group by source: $errors | Group-Object source | Select-Object Count, Name
```

**Source 3: spec issue comments — Triage cluster / Self-Improver findings**

```bash
gh issue view <spec_N> --comments --json comments -q '.comments[].body'
```

Extract from comments:
- `## Review Results` blocks → `reviewer_issues` per capsule
- `## Bug — Max Retries Exhausted` blocks → bug reports
- `## Capsule:` blocks → Developer verification AC checklists
- `## E2E Test Results` blocks → e2e pass/fail per AC
- `## Retro Report` blocks → previous Self-Improver findings

---

## Reference: ACE Lifecycle in Fredo Terms

```
┌─────────────────────────────────────────────────────┐
│                    ACE CYCLE                         │
│                                                     │
│  GENERATE ──→ REFLECT ──→ CURATE                    │
│     │            │            │                      │
│  Fredo:       Fredo:       Fredo:                   │
│  Self-        Recipe 1     Recipe 4                 │
│  Improver     (effective-  (decision                │
│  reads        ness check)  tree: archive            │
│  metrics,                  / escalate /             │
│  proposes                  compose)                 │
│  improvement                                       │
│  PR                                                │
│                                                     │
│  GENERATE ←─────────────────────────────────────── │
│     │                                                │
│  Fredo:                                              │
│  Next spec runs with                                 │
│  improved playbooks +                                 │
│  guardrails                                          │
└─────────────────────────────────────────────────────┘
```

**Key ACE insight:** "Prevents collapse with structured, incremental updates that preserve detailed knowledge." Active guardrails MUST be structured with `guardrail_id`, `target_failure`, and `effectiveness` — without this structure, the context collapses (as the SI's improvement ledger grows, rules get lost). Guardrail records live in the event log (`audit.verdict` messages) and the pipeline docs/skills the SI maintains, not in a standalone file.
