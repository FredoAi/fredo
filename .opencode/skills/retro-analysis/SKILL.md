---
name: retro-analysis
description: Post-spec retrospective analysis recipes for guardrail effectiveness tracking, cross-spec pattern detection, grounded verification, ACE curation lifecycle, and compositional skill building. Load when the retro-analyst performs post-spec improvement generation.
---

# Retro-Analysis — Self-Improvement Recipes

## Overview

This skill provides reusable technical recipes for the retro-analyst agent. The retro-analyst owns policy decisions (what to guard, when to escalate, how to report); this skill owns the execution mechanics (how to compute effectiveness, detect patterns, verify prompts).

**Core framework:** ACE (Agentic Context Engineering) Generation → Reflection → Curation cycle:
1. **Generation**: Propose improvements from telemetry data
2. **Reflection**: Verify previous improvements worked (Self-Refine pattern)
3. **Curation**: Prune stale, escalate violated, compose working guardrails (Voyager skill library)

---

## Recipe 1: Guardrail Effectiveness Computation

Computes whether an Active guardrail reduced its target failure class after activation.

**Data sources:**
- `.opencode/IMPROVEMENTS.md` Active table — `guardrail_id`, `activation_date`, `target_failure` columns
- `.opencode/metrics.json` — per-spec `top_failure`, `timestamp` fields

**Algorithm:**

```
For each Active guardrail with guardrail_id:
  1. Parse activation_date from IMPROVEMENTS.md
  2. Query metrics.json for all specs BEFORE activation_date:
     - Count specs where top_failure == guardrail.target_failure
     - Total specs in before window
     - Compute before_rate = count / total
  3. Query metrics.json for all specs AFTER activation_date:
     - Count specs where top_failure == guardrail.target_failure
     - Total specs in after window
     - Compute after_rate = count / total
  4. Classification:
     - after_rate == 0 AND total_specs_after >= 2     → "Confirmed"
     - after_rate == 0 AND total_specs_after < 2      → "Pending"
     - after_rate > 0 AND after_rate < before_rate     → "Partial"
     - after_rate >= before_rate                        → "Ineffective"
  5. Write effectiveness value back to IMPROVEMENTS.md
```

**Implementation via bash:**

```powershell
# Extract guardrail data from IMPROVEMENTS.md Active table
# The table has columns: guardrail_id | date | trigger | target_failure | change | justification | effectiveness | composed_from
# Use regex to parse pipe-delimited rows, skip header/separator rows

$improvements = Get-Content -Raw ".opencode/IMPROVEMENTS.md"
$guardrails = @()
# Parse Active table rows (after "## Active", before "## Archived")
# Each non-empty, non-header row: | G-XXX | YYYY-MM-DD | ... |
$inActive = $false
foreach ($line in ($improvements -split "`n")) {
  if ($line -match "^## Active") { $inActive = $true; continue }
  if ($line -match "^## Archived") { break }
  if ($inActive -and $line -match "^\|\s*(G-\d+)\s*\|") {
    $fields = $line -split '\s*\|\s*'
    if ($fields.Count -ge 8) {
      $guardrails += @{
        guardrail_id = $fields[1].Trim()
        activation_date = $fields[2].Trim()
        target_failure = $fields[4].Trim()
        effectiveness = $fields[7].Trim()
      }
    }
  }
}

# For each guardrail, compute effectiveness from metrics.json
$metrics = Get-Content -Raw ".opencode/metrics.json" | ConvertFrom-Json
foreach ($g in $guardrails) {
  $before = 0; $after = 0; $beforeTotal = 0; $afterTotal = 0
  foreach ($spec in $metrics.specs.PSObject.Properties) {
    $ts = $spec.Value.timestamp
    $tf = $spec.Value.top_failure
    if ($ts -lt $g.activation_date) {
      $beforeTotal++
      if ($tf -eq $g.target_failure) { $before++ }
    } else {
      $afterTotal++
      if ($tf -eq $g.target_failure) { $after++ }
    }
  }
  # Classification
  if ($after -eq 0 -and $afterTotal -ge 2) { $g.effectiveness = "Confirmed" }
  elseif ($after -eq 0 -and $afterTotal -lt 2) { $g.effectiveness = "Pending" }
  elseif ($after -gt 0 -and ($after / $afterTotal) -lt ($before / [Math]::Max($beforeTotal, 1))) { $g.effectiveness = "Partial" }
  else { $g.effectiveness = "Ineffective" }
}
```

---

## Recipe 2: Cross-Spec Pattern Scanner

Detects recurring failure patterns across multiple specs for guardrail promotion.

**Algorithm:**

```
1. Read ALL specs from metrics.json
2. Group by top_failure value:
   - cross_capsule_conflict: [spec #108, #124, #275, #407]
   - no_upfront_research: [spec #265, #369, #382]
   - none: [spec #93, #102, ...]
3. For each failure class with >= 2 occurrences:
   - Check if an Active guardrail already exists with matching target_failure
   - If NO: flag as "unguarded pattern" → candidate for new guardrail
   - If YES: flag as "guarded pattern" → use Recipe 1 to check effectiveness
4. For "unguarded patterns" with >= 3 occurrences:
   - Priority: P0 (recurring, unguarded)
   - Extract all architect_issues and reviewer_issues from matching specs
   - Propose guardrail text from the common theme in issues
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

Checks whether a guardrail actually exists in the relevant agent prompt, or is only in IMPROVEMENTS.md (orphaned).

**Algorithm:**

```
For each Active guardrail:
  1. Determine target agent from change description:
     - "Architect must ..." → read .opencode/agents/architect.md
     - "Reviewer must ..." → read .opencode/agents/reviewer.md
     - "Coder must ..." → read .opencode/agents/coder.md
     - "Pipeline" → read relevant .opencode/scripts/*.ps1
  2. Search for the guardrail's key rule in the target file:
     - Via grep for distinctive phrases (e.g., "exclusive file ownership", "pre-commit contract")
  3. Classify:
     - "Baked in": Rule text found verbatim in agent prompt → no action needed
     - "Absent": Rule NOT in agent prompt → guardrail is orphaned, needs prompt update
     - "Ignored": Rule IS in prompt but failure recurred → guardrail needs escalation to hook
  4. For "Ignored": Check if the violated spec's architect_issues / reviewer_issues mention the rule
     - If mentioned AND still violated → agent saw the rule but ignored it → needs enforcement
     - If NOT mentioned → agent didn't see the rule → prompt placement issue (too deep, buried)
```

**Implementation via bash:**

```powershell
$guardrailRule = "exclusive file ownership"  # extract from guardrail change text
$targetPrompt = ".opencode/agents/architect.md"
$found = Select-String -Path $targetPrompt -Pattern $guardrailRule -SimpleMatch -Quiet
if (-not $found) {
  Write-Output "GUARDRAIL ORPHANED: '$guardrailRule' not found in $targetPrompt"
  Write-Output "→ Add rule to agent prompt to close the grounded verification gap"
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
│  ├─ Rule is "Baked in" to agent prompt?
│  │  ├─ YES → PROPOSE ARCHIVE (guardrail baked into prompt, no longer needs Active tracking)
│  │  │        Archive justification: "Baked into <agent>.md line <N>. No occurrences in <M> specs."
│  │  └─ NO  → KEEP ACTIVE (guardrail works but not yet in prompt — add to prompt first, then re-evaluate)
│  │
├─ EFFECTIVENESS = "Partial" (reduced but not eliminated)
│  └─ KEEP ACTIVE, update change text to be more specific (strengthen rule)
│
├─ EFFECTIVENESS = "Pending" (< 2 specs since activation)
│  └─ KEEP ACTIVE (not enough data to evaluate — wait for more specs)
│
├─ EFFECTIVENESS = "Ineffective" (same rate or worse)
│  ├─ Rule is "Ignored" (in prompt but violated)?
│  │  ├─ YES → ESCALATE TO HOOK (prompt-level rule not sufficient)
│  │  │        Escalation report: "Guardrail G-XXX violated in spec #N despite being in <agent>.md.
│  │  │        Recommendation: implement as a deterministic check in <script>/<CI step>."
│  │  └─ NO  → STRENGTHEN RULE (add negative examples, move to earlier step, add verifier)
│
└─ STALENESS CHECK (not triggered in 10+ specs)
   └─ PROPOSE ARCHIVE (failure class extinct or pipeline changed)
```

**Compositional skill detection (Voyager/Odyssey):**

When 3+ guardrails share the same `target_failure` AND are all "Confirmed":
→ Propose them as a **Compositional Skill** in IMPROVEMENTS.md:
```
### CS-001: Cross-Capsule Conflict Prevention
composed_from: [G-002, G-003, G-006]
effectiveness: 0 occurrences in last 5 specs
```

---

## Recipe 5: Telemetry Data Extraction

Standardized extraction patterns for the 3 retro-analyst data sources.

**Source 1: metrics.json — spec-level metrics**

```powershell
$metrics = Get-Content ".opencode/metrics.json" | ConvertFrom-Json
$specs = $metrics.specs.PSObject.Properties | ForEach-Object {
  [PSCustomObject]@{
    spec = $_.Name
    tasks = $_.Value.tasks
    merged = $_.Value.merged
    top_failure = $_.Value.top_failure
    architect_issues = $_.Value.architect_issues -join "; "
    reviewer_issues = $_.Value.reviewer_issues -join "; "
    passed_e2e = $_.Value.passed_e2e
    closed_as = $_.Value.closed_as
    timestamp = $_.Value.timestamp
    capsules_first_pass = $_.Value.capsules_first_pass
    capsules_total = $_.Value.capsules_total
  }
}
```

**Source 2: script-errors.jsonl — pipeline failures**

```powershell
$errors = Get-Content ".opencode/state/script-errors.jsonl" | ForEach-Object {
  $_ | ConvertFrom-Json
}
# Filter by issue number: $errors | Where-Object { $_.issue -eq "N" }
# Group by source: $errors | Group-Object source | Select-Object Count, Name
```

**Source 3: spec issue comments — Reviewer findings**

```bash
gh issue view <spec_N> --comments --json comments -q '.comments[].body'
```

Extract from comments:
- `## Review Results` blocks → `reviewer_issues` per capsule
- `## Bug — Max Retries Exhausted` blocks → bug reports
- `## Capsule:` blocks → Coder verification AC checklists
- `## E2E Test Results` blocks → e2e pass/fail per AC
- `## Retro Report` blocks → previous retro-analyst findings

---

## Reference: ACE Lifecycle in Fredo Terms

```
┌─────────────────────────────────────────────────────┐
│                    ACE CYCLE                         │
│                                                     │
│  GENERATE ──→ REFLECT ──→ CURATE                    │
│     │            │            │                      │
│  Fredo:       Fredo:       Fredo:                   │
│  Retro-       Recipe 1     Recipe 4                 │
│  Analyst      (effective-  (decision                │
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
│  improved prompts +                                   │
│  guardrails                                          │
└─────────────────────────────────────────────────────┘
```

**Key ACE insight:** "Prevents collapse with structured, incremental updates that preserve detailed knowledge." Active guardrails MUST be structured with `guardrail_id`, `target_failure`, and `effectiveness` — without this structure, the context collapses (as IMPROVEMENTS.md grows, rules get lost).
